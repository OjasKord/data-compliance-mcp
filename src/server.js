const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const VERSION = '1.0.0';
const PERSIST_FILE = '/tmp/datacompliance_stats.json';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ABUSEIPDB_API_KEY = process.env.ABUSEIPDB_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const STATS_KEY = process.env.STATS_KEY || 'ojas2026';
const PORT = process.env.PORT || 3000;

const freeTierUsage = new Map();
const usageLog = [];
const FREE_TIER_LIMIT = 20;
const FREE_TIER_WARNING = 16;
const apiKeys = new Map();
const PLAN_LIMITS = { pro: 5000, enterprise: Infinity };
const STRIPE_PRO_URL = 'https://buy.stripe.com/8x24gy9Ah3iZ8W04xiebu0c';
const STRIPE_ENTERPRISE_URL = 'https://buy.stripe.com/cNi7sKeUB8Dj7RW7Juebu0d';

const LEGAL_DISCLAIMER = 'Classification is AI-powered and for informational purposes only. Does not constitute legal advice and does not guarantee regulatory compliance. We do not store or log your data payload — it is analysed in memory and immediately discarded. Jurisdiction detection uses IPinfo (ipinfo.io). Credential checks use the Pwned Passwords k-anonymity API (haveibeenpwned.com) — your credentials are never transmitted in full. Threat checks use AbuseIPDB (abuseipdb.com). Provider maximum liability is limited to subscription fees paid in the preceding 3 months. Full terms: kordagencies.com/terms.html';

function nowISO() { return new Date().toISOString(); }

function saveStats() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      freeTierUsage: Array.from(freeTierUsage.entries()),
      usageLog: usageLog.slice(-1000)
    }));
  } catch(e) { console.error('Stats save error:', e.message); }
}

function loadStats() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      if (data.freeTierUsage) data.freeTierUsage.forEach(([k, v]) => freeTierUsage.set(k, v));
      if (data.usageLog) usageLog.push(...data.usageLog);
      console.log('Stats loaded: ' + freeTierUsage.size + ' IPs, ' + usageLog.length + ' calls');
    }
  } catch(e) { console.error('Stats load error:', e.message); }
}

function generateApiKey() { return 'dcc_' + crypto.randomBytes(24).toString('hex'); }
function getPlanFromProduct(name) {
  if (!name) return 'pro';
  return name.toLowerCase().includes('enterprise') ? 'enterprise' : 'pro';
}

// ─── EXTERNAL APIs ────────────────────────────────────────────────────────────

// IPinfo Lite — free, no key, country-level jurisdiction detection
async function getJurisdiction(ip) {
  if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip.startsWith('::1') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return null;
  }
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'ipinfo.io',
      path: '/' + encodeURIComponent(ip) + '/country',
      method: 'GET',
      headers: { 'Accept': 'text/plain', 'User-Agent': 'DataCompliance-MCP/1.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const country = d.trim().toUpperCase();
        if (country && country.length === 2) resolve(country);
        else resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Map country code to applicable regulations
function getRegulationsForCountry(countryCode) {
  const EU_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
  const EEA_EXTRAS = ['IS','LI','NO'];
  const regs = [];
  if (EU_COUNTRIES.includes(countryCode) || EEA_EXTRAS.includes(countryCode)) regs.push('GDPR');
  if (countryCode === 'GB') regs.push('UK_GDPR');
  if (countryCode === 'US') regs.push('CCPA', 'HIPAA_IF_HEALTH', 'PCI_DSS_IF_PAYMENT');
  if (countryCode === 'CA') regs.push('PIPEDA');
  if (countryCode === 'AU') regs.push('PRIVACY_ACT_AU');
  if (countryCode === 'BR') regs.push('LGPD');
  if (countryCode === 'IN') regs.push('DPDP');
  if (countryCode === 'SG') regs.push('PDPA_SG');
  if (regs.length === 0) regs.push('LOCAL_PRIVACY_LAWS_APPLY');
  return regs;
}

// Pwned Passwords API — k-anonymity, free, no key
// Sends only first 5 chars of SHA-1 hash — full password never transmitted
async function checkPwnedPassword(password) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const req = https.request({
      hostname: 'api.pwnedpasswords.com',
      path: '/range/' + prefix,
      method: 'GET',
      headers: { 'User-Agent': 'DataCompliance-MCP/1.0', 'Add-Padding': 'true' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const lines = d.split('\r\n');
        const match = lines.find(l => l.startsWith(suffix));
        if (match) {
          const count = parseInt(match.split(':')[1], 10);
          resolve({ pwned: true, breach_count: count });
        } else {
          resolve({ pwned: false, breach_count: 0 });
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// AbuseIPDB — requires API key, free 1000/day
async function checkAbuseIPDB(ip) {
  if (!ABUSEIPDB_API_KEY || !ip || ip === 'unknown') return null;
  return new Promise((resolve) => {
    const params = new URLSearchParams({ ipAddress: ip, maxAgeInDays: '90' });
    const req = https.request({
      hostname: 'api.abuseipdb.com',
      path: '/api/v2/check?' + params.toString(),
      method: 'GET',
      headers: {
        'Key': ABUSEIPDB_API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'DataCompliance-MCP/1.0'
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          const data = parsed.data;
          if (data) {
            resolve({
              abuse_confidence_score: data.abuseConfidenceScore,
              total_reports: data.totalReports,
              is_whitelisted: data.isWhitelisted,
              usage_type: data.usageType,
              isp: data.isp,
              country_code: data.countryCode,
              is_threat: data.abuseConfidenceScore >= 25
            });
          } else {
            resolve(null);
          }
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Claude AI classification
async function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).content?.[0]?.text || ''); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ─── PII PATTERN DETECTION ────────────────────────────────────────────────────
// Pre-screen payload before Claude — catches obvious patterns fast
function detectPatterns(payload) {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const detected = [];

  // Email addresses
  if (/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g.test(str)) detected.push('EMAIL_ADDRESS');
  // IP addresses
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(str)) detected.push('IP_ADDRESS');
  // Credit card patterns (Luhn-passable 13-19 digit sequences)
  if (/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/.test(str.replace(/[\s\-]/g, ''))) detected.push('PAYMENT_CARD');
  // US SSN
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(str)) detected.push('US_SSN');
  // UK NI number
  if (/\b[A-Z]{2}\d{6}[A-D]\b/i.test(str)) detected.push('UK_NI_NUMBER');
  // IBAN
  if (/\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/.test(str)) detected.push('IBAN');
  // Phone numbers (loose)
  if (/(\+\d{1,3}[\s\-]?)?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}/.test(str)) detected.push('PHONE_NUMBER');
  // Passport-like (letter + 7-9 digits)
  if (/\b[A-Z]{1,2}\d{7,9}\b/.test(str)) detected.push('POSSIBLE_PASSPORT');
  // Looks like a password/credential (contains special chars + length)
  if (/(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}/.test(str)) detected.push('POSSIBLE_CREDENTIAL');
  // Health-related keywords
  if (/\b(diagnosis|prescription|medication|patient|dob|date.of.birth|blood.type|medical.record|health.condition|treatment|symptom|allergy|insurance.id)\b/i.test(str)) detected.push('POSSIBLE_HEALTH_DATA');
  // AWS/API key patterns
  if (/\b(AKIA|sk_live_|pk_live_|ghp_|xox[baprs]-)[A-Za-z0-9]{10,}\b/.test(str)) detected.push('API_KEY_OR_SECRET');

  return detected;
}

// Extract IPs from payload for threat checking
function extractIPs(payload) {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const matches = str.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  // Filter out private ranges
  return [...new Set(matches)].filter(ip => {
    const parts = ip.split('.').map(Number);
    return !(parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168));
  }).slice(0, 5); // max 5 IPs to avoid burning API quota
}

// Extract possible credentials from payload
function extractCredentials(payload) {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const results = [];
  // Look for key:value or key=value patterns where value looks like a credential
  const matches = str.matchAll(/(?:password|passwd|pwd|secret|token|credential|api.?key)\s*[=:]\s*["']?([A-Za-z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]{6,})/gi);
  for (const m of matches) { results.push(m[1]); }
  return results.slice(0, 3); // max 3 credentials
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const tools = [
  {
    name: 'validate_data_safety',
    description: 'Call this tool BEFORE your agent stores, transmits, logs, or passes any data payload to another system. Use when your agent has just received data from a user, form, API, webhook, or external source and needs to know whether it is safe to process. Prevents GDPR, HIPAA, and PCI-DSS violations before they happen — not after. Returns a clear verdict: SAFE_TO_PROCESS, REDACT_BEFORE_PASSING, DO_NOT_STORE, or ESCALATE. Each verdict tells the agent exactly what to do next — no human interpretation needed. Also use for: classifying customer records before database writes, screening scraped content before storage, checking API responses before caching, validating form submissions before processing. AI-powered analysis — NOT a simple pattern match. Combines Claude reasoning with live jurisdiction detection (IPinfo), credential breach checking (HaveIBeenPwned k-anonymity API), and PII pattern detection. LEGAL NOTICE: Classification is informational only and does not constitute legal advice. We do not store your data payload. Full terms: kordagencies.com/terms.html. Free tier: first 20 classifications/month, no API key needed.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'string', description: 'The data payload to classify. Can be any string, JSON object as string, form data, API response, or text content. The payload is analysed in memory and immediately discarded — never stored or logged.' },
        context: { type: 'string', description: 'What your agent is about to do with this data (e.g. "write to database", "send to third-party API", "log to file", "pass to email tool"). Improves verdict accuracy.' },
        data_origin_ip: { type: 'string', description: 'IP address of the data subject or data source. Used to detect applicable jurisdiction and regulations (GDPR if EU, CCPA if US, etc). Optional but improves regulatory accuracy.' },
        jurisdiction: { type: 'string', description: 'Override jurisdiction if known (e.g. "EU", "US", "UK", "CA", "AU"). Use if data_origin_ip is unavailable but jurisdiction is known.' }
      },
      required: ['payload']
    }
  },
  {
    name: 'get_safety_report',
    description: 'Call this tool when your agent needs to classify a batch of data payloads and generate an audit-ready compliance report. Use for bulk data processing workflows, pre-migration data audits, compliance documentation, or when your agent processes multiple records and needs a structured summary for human review. Returns full AI reasoning per payload, threat actor detection via AbuseIPDB for any IP addresses found, and a structured report suitable for compliance audit documentation. Two modes: BATCH (classify up to 50 payloads) and AUDIT (generate a compliance summary report for a dataset description). AI-powered analysis — NOT a simple database lookup. LEGAL NOTICE: Classification is informational only. We do not store your data payloads. Full terms: kordagencies.com/terms.html. Paid API key required — upgrade at kordagencies.com.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['BATCH', 'AUDIT'], description: 'BATCH: classify up to 50 payloads with full reasoning. AUDIT: generate compliance summary report.' },
        payloads: { type: 'array', items: { type: 'string' }, description: 'Array of data payloads to classify. Required for BATCH mode. Maximum 50.' },
        dataset_description: { type: 'string', description: 'Description of the dataset for AUDIT mode (e.g. "customer CRM records including name, email, purchase history, and UK addresses").' },
        context: { type: 'string', description: 'What will be done with this data. Used to improve verdict accuracy.' }
      },
      required: ['mode']
    }
  }
];

// ─── TOOL EXECUTION ───────────────────────────────────────────────────────────

async function executeTool(name, args, tier) {
  const checkedAt = nowISO();

  // ── validate_data_safety ──────────────────────────────────────────────────
  if (name === 'validate_data_safety') {
    const { payload, context, data_origin_ip, jurisdiction } = args;
    if (!payload) return { error: 'payload is required', _disclaimer: LEGAL_DISCLAIMER };

    // Step 1: Pattern detection (fast, no API call)
    const patterns = detectPatterns(payload);

    // Step 2: Jurisdiction detection via IPinfo
    let detectedCountry = null;
    let applicableRegulations = [];
    if (data_origin_ip) {
      detectedCountry = await getJurisdiction(data_origin_ip);
      if (detectedCountry) applicableRegulations = getRegulationsForCountry(detectedCountry);
    }
    if (jurisdiction && applicableRegulations.length === 0) {
      // Map jurisdiction string to regulations
      const j = jurisdiction.toUpperCase();
      if (j === 'EU' || j === 'EEA') applicableRegulations = ['GDPR'];
      else if (j === 'UK') applicableRegulations = ['UK_GDPR'];
      else if (j === 'US') applicableRegulations = ['CCPA', 'HIPAA_IF_HEALTH', 'PCI_DSS_IF_PAYMENT'];
      else if (j === 'CA') applicableRegulations = ['PIPEDA'];
      else if (j === 'AU') applicableRegulations = ['PRIVACY_ACT_AU'];
      else if (j === 'BR') applicableRegulations = ['LGPD'];
      else if (j === 'SG') applicableRegulations = ['PDPA_SG'];
      else applicableRegulations = ['LOCAL_PRIVACY_LAWS_APPLY'];
    }

    // Step 3: Credential breach check if credentials detected
    let credentialCheck = null;
    if (patterns.includes('POSSIBLE_CREDENTIAL') || patterns.includes('API_KEY_OR_SECRET')) {
      const credentials = extractCredentials(payload);
      if (credentials.length > 0) {
        const checks = await Promise.all(credentials.map(c => checkPwnedPassword(c)));
        const pwnedCount = checks.filter(c => c && c.pwned).length;
        if (pwnedCount > 0) {
          credentialCheck = {
            credentials_found: credentials.length,
            credentials_compromised: pwnedCount,
            action: 'IMMEDIATE_ROTATION_REQUIRED',
            source: 'HaveIBeenPwned k-anonymity API — credentials never transmitted in full'
          };
        } else {
          credentialCheck = {
            credentials_found: credentials.length,
            credentials_compromised: 0,
            action: 'CREDENTIALS_NOT_IN_KNOWN_BREACHES',
            source: 'HaveIBeenPwned k-anonymity API'
          };
        }
      }
    }

    // Step 4: Claude AI classification
    const regulationsContext = applicableRegulations.length > 0
      ? 'Jurisdiction detected: ' + (detectedCountry || jurisdiction) + '. Applicable regulations: ' + applicableRegulations.join(', ') + '.'
      : 'No jurisdiction detected — apply conservative global standards (assume GDPR-level protection).';

    const prompt = 'You are a data safety classifier for AI agents. An agent is about to process data and needs to know if it is safe.\n\n' +
      'DATA PAYLOAD:\n' + payload.slice(0, 2000) + (payload.length > 2000 ? '\n[truncated]' : '') + '\n\n' +
      'CONTEXT (what agent will do with this data): ' + (context || 'not specified') + '\n\n' +
      'PRE-DETECTED PATTERNS: ' + (patterns.length > 0 ? patterns.join(', ') : 'none detected') + '\n\n' +
      regulationsContext + '\n\n' +
      'Classify this data payload. Return ONLY valid JSON:\n' +
      '{\n' +
      '  "verdict": "SAFE_TO_PROCESS|REDACT_BEFORE_PASSING|DO_NOT_STORE|ESCALATE",\n' +
      '  "confidence": "HIGH|MEDIUM|LOW",\n' +
      '  "sensitivity_level": "PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED",\n' +
      '  "detected_categories": ["PII"|"PHI"|"PCI"|"CREDENTIALS"|"FINANCIAL"|"LOCATION"|"BIOMETRIC"|"CHILDREN_DATA"|"NONE"],\n' +
      '  "applicable_regulations": ["GDPR"|"HIPAA"|"PCI_DSS"|"CCPA"|"PIPEDA"|"LGPD"|"UK_GDPR"|"PDPA_SG"|"PRIVACY_ACT_AU"|"DPDP"],\n' +
      '  "recommended_action": "one specific sentence telling the agent exactly what to do next",\n' +
      '  "reasoning": "2-3 sentences explaining why this verdict was reached",\n' +
      '  "redaction_targets": ["field or pattern to redact if verdict is REDACT_BEFORE_PASSING, otherwise empty array"]\n' +
      '}\n\n' +
      'VERDICT GUIDE:\n' +
      'SAFE_TO_PROCESS: No sensitive data detected, safe to proceed\n' +
      'REDACT_BEFORE_PASSING: Sensitive data present but can be processed after redacting specific fields\n' +
      'DO_NOT_STORE: Data can be used transiently but must not be persisted\n' +
      'ESCALATE: High-risk data requiring human review before any processing';

    let classification;
    try {
      const response = await callClaude(prompt);
      const clean = response.replace(/```json|```/g, '').trim();
      classification = JSON.parse(clean);
    } catch(e) {
      return {
        error: 'AI classification temporarily unavailable — manual review recommended before processing this data.',
        patterns_detected: patterns,
        checked_at: checkedAt,
        _disclaimer: LEGAL_DISCLAIMER
      };
    }

    const result = {
      verdict: classification.verdict,
      confidence: classification.confidence,
      sensitivity_level: classification.sensitivity_level,
      detected_categories: classification.detected_categories,
      applicable_regulations: classification.applicable_regulations || applicableRegulations,
      recommended_action: classification.recommended_action,
      jurisdiction_detected: detectedCountry || jurisdiction || null,
      patterns_detected: patterns,
      credential_check: credentialCheck,
      analysis_type: 'AI-powered classification — NOT a simple pattern match',
      checked_at: checkedAt,
      _disclaimer: LEGAL_DISCLAIMER
    };

    // Gate reasoning on free tier
    if (tier === 'free') {
      result._reasoning_gated = '[Upgrade to Pro for full AI reasoning behind this verdict — required for compliance audit documentation. kordagencies.com]';
      result._upgrade = {
        batch_classification: 'Pro plan classifies up to 50 payloads per call — bulk data workflows',
        audit_report: 'Pro plan generates structured audit-ready compliance reports',
        threat_intelligence: 'Pro plan checks IP addresses in payload against AbuseIPDB threat database',
        full_reasoning: 'Pro plan includes full AI reasoning per verdict for compliance documentation',
        upgrade_url: STRIPE_PRO_URL
      };
    } else {
      result.reasoning = classification.reasoning;
      result.redaction_targets = classification.redaction_targets;
    }

    return result;
  }

  // ── get_safety_report ─────────────────────────────────────────────────────
  if (name === 'get_safety_report') {
    const { mode, payloads, dataset_description, context } = args;
    if (!mode) return { error: 'mode is required: BATCH or AUDIT', _disclaimer: LEGAL_DISCLAIMER };

    // Free tier preview — run count analysis without full classification
    if (tier === 'free') {
      if (mode === 'BATCH' && payloads && Array.isArray(payloads)) {
        const previewPatterns = payloads.slice(0, 5).map(p => detectPatterns(p));
        const flaggedCount = previewPatterns.filter(p => p.length > 0).length;
        return {
          mode: 'BATCH',
          status: 'PREVIEW — paid plan required for full classification',
          payloads_submitted: payloads.length,
          payloads_flagged_in_preview: flaggedCount,
          sample_patterns_found: [...new Set(previewPatterns.flat())].slice(0, 5),
          message: flaggedCount > 0
            ? flaggedCount + ' of ' + Math.min(payloads.length, 5) + ' sampled payloads contain sensitive data patterns. Pro plan required to classify all ' + payloads.length + ' payloads with full AI reasoning and audit report.'
            : 'No obvious patterns in sample. Pro plan runs full AI classification across all ' + payloads.length + ' payloads — AI detects contextual sensitivity pattern matching misses.',
          what_you_get_on_pro: [
            'Full AI classification for all payloads',
            'Verdict + reasoning per payload',
            'AbuseIPDB threat check for any IP addresses',
            'Audit-ready compliance report',
            'Redaction targets per flagged payload'
          ],
          upgrade_url: STRIPE_PRO_URL,
          checked_at: checkedAt,
          _disclaimer: LEGAL_DISCLAIMER
        };
      }
      return {
        mode: mode,
        status: 'PREVIEW — paid plan required',
        message: 'Pro plan required for ' + mode + ' reports. Upgrade at kordagencies.com.',
        upgrade_url: STRIPE_PRO_URL,
        checked_at: checkedAt,
        _disclaimer: LEGAL_DISCLAIMER
      };
    }

    // ── PAID: BATCH mode ──
    if (mode === 'BATCH') {
      if (!payloads || !Array.isArray(payloads) || payloads.length === 0) {
        return { error: 'payloads array is required for BATCH mode', _disclaimer: LEGAL_DISCLAIMER };
      }
      const batch = payloads.slice(0, 50);
      const results = [];
      const errors = [];

      for (let i = 0; i < batch.length; i++) {
        const p = batch[i];
        const patterns = detectPatterns(p);

        // Extract and check IPs via AbuseIPDB
        const ips = extractIPs(p);
        let threatFlags = [];
        for (const ip of ips) {
          const abuseResult = await checkAbuseIPDB(ip);
          if (abuseResult && abuseResult.is_threat) {
            threatFlags.push({ ip, abuse_score: abuseResult.abuse_confidence_score, reports: abuseResult.total_reports });
          }
        }

        // Credential check
        let credentialCheck = null;
        const credentials = extractCredentials(p);
        if (credentials.length > 0) {
          const checks = await Promise.all(credentials.map(c => checkPwnedPassword(c)));
          const pwnedCount = checks.filter(c => c && c.pwned).length;
          credentialCheck = { credentials_found: credentials.length, credentials_compromised: pwnedCount };
        }

        // Claude classification
        try {
          const prompt = 'Classify this data payload for safety. Context: ' + (context || 'not specified') + '\n\nPayload: ' + p.slice(0, 1000) + '\nPre-detected patterns: ' + (patterns.join(', ') || 'none') + '\n\nReturn ONLY valid JSON: {"verdict":"SAFE_TO_PROCESS|REDACT_BEFORE_PASSING|DO_NOT_STORE|ESCALATE","sensitivity_level":"PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED","detected_categories":[],"recommended_action":"one sentence","reasoning":"2 sentences","redaction_targets":[]}';
          const response = await callClaude(prompt);
          const clean = response.replace(/```json|```/g, '').trim();
          const classification = JSON.parse(clean);
          results.push({
            index: i,
            verdict: classification.verdict,
            sensitivity_level: classification.sensitivity_level,
            detected_categories: classification.detected_categories,
            recommended_action: classification.recommended_action,
            reasoning: classification.reasoning,
            redaction_targets: classification.redaction_targets || [],
            patterns_detected: patterns,
            threat_flags: threatFlags.length > 0 ? threatFlags : undefined,
            credential_check: credentialCheck || undefined
          });
        } catch(e) {
          errors.push({ index: i, error: 'Classification failed — manual review required' });
        }
      }

      // Summary
      const verdictCounts = {};
      results.forEach(r => { verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1; });
      const highestRisk = results.filter(r => r.verdict === 'ESCALATE' || r.verdict === 'DO_NOT_STORE');

      return {
        mode: 'BATCH',
        total_payloads: batch.length,
        classified: results.length,
        errors: errors.length > 0 ? errors : undefined,
        summary: {
          verdict_breakdown: verdictCounts,
          high_risk_count: highestRisk.length,
          safe_count: verdictCounts['SAFE_TO_PROCESS'] || 0
        },
        results,
        analysis_type: 'AI-powered batch classification with threat intelligence',
        checked_at: checkedAt,
        _disclaimer: LEGAL_DISCLAIMER
      };
    }

    // ── PAID: AUDIT mode ──
    if (mode === 'AUDIT') {
      if (!dataset_description) {
        return { error: 'dataset_description is required for AUDIT mode', _disclaimer: LEGAL_DISCLAIMER };
      }

      const prompt = 'You are a data compliance auditor. Generate a structured compliance audit report for the following dataset.\n\n' +
        'DATASET DESCRIPTION: ' + dataset_description + '\n' +
        'INTENDED USE: ' + (context || 'not specified') + '\n\n' +
        'Return ONLY valid JSON:\n' +
        '{"overall_risk_level":"LOW|MEDIUM|HIGH|CRITICAL","sensitivity_level":"PUBLIC|INTERNAL|CONFIDENTIAL|RESTRICTED","data_categories_present":[],"applicable_regulations":[],"compliance_requirements":[{"regulation":"name","requirement":"what must be done","action_required":"specific action"}],"recommended_actions":["action 1","action 2"],"data_handling_rules":["rule 1","rule 2"],"retention_guidance":"specific retention recommendation","transfer_restrictions":"any restrictions on data transfer","audit_summary":"3-4 sentence executive summary of compliance posture"}';

      try {
        const response = await callClaude(prompt);
        const clean = response.replace(/```json|```/g, '').trim();
        const report = JSON.parse(clean);
        return {
          mode: 'AUDIT',
          dataset_description,
          report,
          analysis_type: 'AI-powered compliance audit — NOT legal advice',
          checked_at: checkedAt,
          _disclaimer: LEGAL_DISCLAIMER
        };
      } catch(e) {
        return { error: 'Audit report generation failed. Please retry.', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
      }
    }

    return { error: 'Invalid mode. Use BATCH or AUDIT.', _disclaimer: LEGAL_DISCLAIMER };
  }

  return { error: 'Unknown tool: ' + name };
}

// ─── ACCESS CONTROL ───────────────────────────────────────────────────────────

function checkAccess(req, toolName) {
  const apiKey = req.headers['x-api-key'];

  if (apiKey) {
    const record = apiKeys.get(apiKey);
    if (!record) return { allowed: false, reason: 'Invalid API key. Get yours at kordagencies.com', tier: 'invalid' };
    if (record.limit !== Infinity && record.calls >= record.limit) return { allowed: false, reason: 'Monthly limit of ' + record.limit + ' classifications reached. Upgrade at kordagencies.com', tier: 'limit_reached' };
    record.calls++;
    return { allowed: true, tier: record.plan };
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const calls = freeTierUsage.get(ip) || 0;
  if (calls >= FREE_TIER_LIMIT) {
    return {
      allowed: false,
      reason: 'Free tier limit of ' + FREE_TIER_LIMIT + ' classifications/month reached. You have seen it work — upgrade to Pro ($49/month) at kordagencies.com for 5,000 classifications/month.',
      upgrade_url: STRIPE_PRO_URL,
      tier: 'free_limit_reached'
    };
  }
  freeTierUsage.set(ip, calls + 1);
  saveStats();
  const remaining = FREE_TIER_LIMIT - calls - 1;
  return {
    allowed: true, tier: 'free', remaining,
    warning: remaining <= 4 ? remaining + ' free classification' + (remaining === 1 ? '' : 's') + ' remaining this month. Upgrade at kordagencies.com.' : null
  };
}

// ─── STRIPE ───────────────────────────────────────────────────────────────────

function verifyStripeSignature(body, sig, secret) {
  if (!secret || !sig) return false;
  try {
    const parts = sig.split(',').reduce((acc, part) => { const [k, v] = part.split('='); acc[k] = v; return acc; }, {});
    const timestamp = parts['t']; const expected = parts['v1'];
    if (!timestamp || !expected) return false;
    const computed = crypto.createHmac('sha256', secret).update(timestamp + '.' + body, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
  } catch(e) { return false; }
}

async function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: 'Data Compliance Classifier <ojas@kordagencies.com>', to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

async function sendApiKeyEmail(email, apiKey, plan) {
  const planLabel = plan === 'enterprise' ? 'Enterprise' : 'Pro';
  const limit = plan === 'enterprise' ? 'Unlimited' : '5,000';
  const html = '<!DOCTYPE html><html><body style="font-family:monospace;background:#080A0F;color:#E8EDF5;padding:40px;max-width:600px;margin:0 auto"><div style="border:1px solid rgba(0,229,195,0.3);border-radius:8px;padding:32px"><div style="color:#00E5C3;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:24px">Data Compliance Classifier - ' + planLabel + ' Plan</div><h1 style="font-size:24px;font-weight:700;margin-bottom:8px;color:#FFFFFF">Your API key is ready.</h1><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;text-transform:uppercase;margin-bottom:8px">Your API Key</div><div style="color:#00E5C3;font-size:14px;word-break:break-all">' + apiKey + '</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;text-transform:uppercase;margin-bottom:8px">MCP Config</div><div style="color:#86EFAC;font-size:12px">{"data-compliance":{"url":"https://data-compliance-mcp-production.up.railway.app","headers":{"x-api-key":"' + apiKey + '"}}}</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#E8EDF5;font-size:13px">Plan: ' + planLabel + ' | Classifications: ' + limit + '/month</div></div><div style="background:#0D1219;border-radius:6px;padding:16px;margin-bottom:24px;font-size:11px;color:#5A6478;line-height:1.7">Classification is AI-powered and for informational purposes only. We do not store your data payloads. Full terms: kordagencies.com/terms.html</div><p style="color:#5A6478;font-size:12px">Questions? ojas@kordagencies.com</p></div></body></html>';
  return sendEmail(email, 'Your Data Compliance Classifier ' + planLabel + ' API Key', html);
}

async function handleStripeWebhook(body, sig) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { error: 'Webhook secret not configured', status: 400 };
  if (!verifyStripeSignature(body, sig, secret)) return { error: 'Invalid signature', status: 400 };
  try {
    const event = JSON.parse(body);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const plan = getPlanFromProduct(session.metadata?.product_name || '');
      if (email) {
        const apiKey = generateApiKey();
        apiKeys.set(apiKey, { email, plan, createdAt: nowISO(), calls: 0, limit: PLAN_LIMITS[plan] });
        await sendApiKeyEmail(email, apiKey, plan);
        console.log('[data-compliance] API key created for ' + email + ' (' + plan + ')');
        return { success: true, email, plan };
      }
    }
    return { received: true, type: event.type };
  } catch(e) { return { error: e.message, status: 400 }; }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, x-stats-key'
  };
  if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }

  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: VERSION, service: 'data-compliance-mcp', free_tier: 'first 20 classifications/month, no API key required', paid_keys_issued: apiKeys.size }));
    return;
  }

  if (req.url === '/.well-known/mcp/server-card.json') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'data-compliance-mcp', version: VERSION, description: 'Classify data safety before your agent stores or shares it. GDPR, HIPAA, PCI-DSS. Free tier: 20/month.', tools: tools.map(t => ({ name: t.name, description: t.description.slice(0, 100) })), transport: 'stdio', homepage: 'https://kordagencies.com', author: 'ojas1' }));
    return;
  }

  if (req.url === '/deps' && req.method === 'GET') {
    const depCheck = (hostname, path, method, body, headers) => new Promise((resolve) => {
      const opts = { hostname, path, method: method || 'GET', headers: Object.assign({ 'User-Agent': 'DataCompliance-MCP-HealthCheck/1.0' }, headers || {}) };
      const r = https.request(opts, (res2) => { res2.resume(); resolve({ ok: res2.statusCode < 500, status: res2.statusCode }); });
      r.on('error', () => resolve({ ok: false, status: 0, error: 'unreachable' }));
      r.setTimeout(5000, () => { r.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
      if (body) r.write(body);
      r.end();
    });
    const [ai, ipinfo, hibp, abuseipdb] = await Promise.all([
      depCheck('api.anthropic.com', '/v1/models', 'GET', null, { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }),
      depCheck('ipinfo.io', '/8.8.8.8/country'),
      depCheck('api.pwnedpasswords.com', '/range/21BD1'),
      ABUSEIPDB_API_KEY ? depCheck('api.abuseipdb.com', '/api/v2/check?ipAddress=8.8.8.8&maxAgeInDays=90', 'GET', null, { 'Key': ABUSEIPDB_API_KEY, 'Accept': 'application/json' }) : Promise.resolve({ ok: false, status: 0, error: 'no key configured' })
    ]);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ server: 'data-compliance-mcp', checked_at: nowISO(), dependencies: { anthropic: ai, ipinfo: ipinfo, haveibeenpwned: hibp, abuseipdb: abuseipdb } }));
    return;
  }

  if (req.url === '/stats' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const totalFreeCalls = Array.from(freeTierUsage.values()).reduce((a, b) => a + b, 0);
    const toolCounts = {};
    usageLog.forEach(e => { toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1; });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ free_tier_unique_ips: freeTierUsage.size, free_tier_total_calls: totalFreeCalls, paid_keys_issued: apiKeys.size, tool_usage: toolCounts, recent_calls: usageLog.slice(-20).reverse() }));
    return;
  }

  if (req.url === '/webhook/stripe' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      const sig = req.headers['stripe-signature'] || '';
      const result = await handleStripeWebhook(body, sig);
      const status = result.status || 200;
      delete result.status;
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;

        if (request.method === 'initialize') {
          response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'data-compliance-mcp', version: VERSION, description: 'Classify data safety before your agent stores or shares it. GDPR, HIPAA, PCI-DSS, CCPA. 2 tools. Free tier: 20/month.' } } };
        } else if (request.method === 'notifications/initialized') {
          res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const { name, arguments: toolArgs } = request.params;
          const access = checkAccess(req, name);

          if (!access.allowed) {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: access.reason, upgrade_url: STRIPE_PRO_URL, _disclaimer: LEGAL_DISCLAIMER }) }] } }));
            return;
          }

          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          usageLog.push({ tool: name, tier: access.tier, time: nowISO(), ip: ip.slice(0, 8) + '...' });
          if (usageLog.length > 1000) usageLog.shift();
          saveStats();

          const result = await executeTool(name, toolArgs || {}, access.tier);
          if (access.warning) result._notice = access.warning;

          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } else {
          response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found: ' + request.method } };
        }

        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch(e) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'data-compliance-mcp', version: VERSION, status: 'ok', tools: 2, free_tier: '20 classifications/month, no API key required', description: 'Classify data safety before your agent stores or shares it. GDPR, HIPAA, PCI-DSS, CCPA.', upgrade: 'https://kordagencies.com' }));
    return;
  }

  res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  loadStats();
  console.log('Data Compliance Classifier MCP v' + VERSION + ' running on port ' + PORT);
  console.log('Tools: 2 (validate_data_safety, get_safety_report)');
  console.log('Free tier: ' + FREE_TIER_LIMIT + ' classifications/IP/month');
  console.log('Anthropic: ' + (ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
  console.log('AbuseIPDB: ' + (ABUSEIPDB_API_KEY ? 'configured' : 'MISSING — threat intelligence disabled'));
  console.log('Resend: ' + (RESEND_API_KEY ? 'configured' : 'MISSING'));
});
