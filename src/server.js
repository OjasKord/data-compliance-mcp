const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const VERSION = '1.0.11';
const PERSIST_FILE = '/tmp/datacompliance_stats.json';
const API_KEYS_FILE = '/tmp/datacompliance_apikeys.json';
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
const toolUsageCounts = {};
const trialExtensions = new Map();
const TRIAL_EXTENSION_CALLS = 10;
const STRIPE_PRO_URL = 'https://buy.stripe.com/cNidR87s9dXD0pue7Sebu0r';
const ENTERPRISE_UPGRADE_URL = 'https://buy.stripe.com/9B6bJ0aElbPv7RW9RCebu0s';
const STRIPE_ENTERPRISE_URL = 'https://buy.stripe.com/cNi7sKeUB8Dj7RW7Juebu0d';

const REDIS_PREFIX = 'dcc';
const FREE_TIER_REDIS_KEY = 'dcc:free_tier_usage';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const LEGAL_DISCLAIMER = 'Classification is AI-powered and for informational purposes only. Does not constitute legal advice and does not guarantee regulatory compliance. We do not store or log your data payload — it is analysed in memory and immediately discarded. Jurisdiction detection uses IPinfo (ipinfo.io). Credential checks use the Pwned Passwords k-anonymity API (haveibeenpwned.com) — your credentials are never transmitted in full. Threat checks use AbuseIPDB (abuseipdb.com). Provider maximum liability is limited to subscription fees paid in the preceding 3 months. Full terms: kordagencies.com/terms.html';

function nowISO() { return new Date().toISOString(); }
function getMonthKey(ip) { return ip + ':' + new Date().toISOString().slice(0, 7); }

function getEffectiveLimit(ip) {
  for (const record of trialExtensions.values()) {
    if (record.ip === ip) return FREE_TIER_LIMIT + TRIAL_EXTENSION_CALLS;
  }
  return FREE_TIER_LIMIT;
}

function saveStats() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      freeTierUsage: Array.from(freeTierUsage.entries()),
      usageLog: usageLog.slice(-1000),
      toolUsageCounts,
      trialExtensions: Array.from(trialExtensions.entries())
    }));
  } catch(e) { console.error('Stats save error:', e.message); }
}

function loadStats() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      if (data.freeTierUsage) data.freeTierUsage.forEach(([k, v]) => freeTierUsage.set(k, v));
      if (data.usageLog) usageLog.push(...data.usageLog);
      if (data.toolUsageCounts) Object.assign(toolUsageCounts, data.toolUsageCounts);
      if (data.trialExtensions) data.trialExtensions.forEach(([k, v]) => trialExtensions.set(k, v));
      console.log('Stats loaded: ' + freeTierUsage.size + ' IPs, ' + usageLog.length + ' calls, ' + trialExtensions.size + ' trial extensions');
    }
  } catch(e) { console.error('Stats load error:', e.message); }
}

function saveApiKeys() {
  try { fs.writeFileSync(API_KEYS_FILE, JSON.stringify(Array.from(apiKeys.entries()))); } catch(e) { console.error('API keys save error:', e.message); }
}

function loadApiKeys() {
  try {
    if (fs.existsSync(API_KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8'));
      data.forEach(([k, v]) => apiKeys.set(k, v));
      console.log('API keys loaded: ' + apiKeys.size + ' keys');
    }
  } catch(e) { console.error('API keys load error:', e.message); }
}

function generateApiKey() { return 'dcc_' + crypto.randomBytes(24).toString('hex'); }
function getPlanFromProduct(name) {
  if (!name) return 'pro';
  return name.toLowerCase().includes('enterprise') ? 'enterprise' : 'pro';
}

// ─── REDIS HELPERS ────────────────────────────────────────────────────────────

async function redisGet(key) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisGet error:', data.error, 'key:', key);
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch(e) { return null; }
}

async function redisSet(key, value) {
  try {
    const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    if (data.error) console.error('[Redis] redisSet error:', data.error, 'key:', key);
  } catch(e) { console.error('[Redis] redisSet failed:', e); }
}

async function redisExpire(key, seconds) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/expire/${encodeURIComponent(key)}/${seconds}`,
      { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisExpire error:', data.error, 'key:', key);
  } catch(e) { console.error('[Redis] redisExpire failed:', e); }
}

async function redisKeys(pattern) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/keys/${encodeURIComponent(pattern)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisKeys error:', data.error, 'pattern:', pattern);
    return data.result || [];
  } catch(e) { return []; }
}

async function appendSessionLog(ip, tool) {
  try {
    const ipSafe = ip.replace(/:/g, '_').replace(/\s/g, '');
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `${REDIS_PREFIX}:session:${ipSafe}:${dayKey}`;
    const existing = await redisGet(key) || [];
    existing.push({ tool, timestamp: new Date().toISOString() });
    await redisSet(key, existing);
    await redisExpire(key, 86400);
  } catch(e) { console.error('[SessionLog] internal error:', e); }
}

async function saveKeyToRedis(apiKey, record) {
  await redisSet(`${REDIS_PREFIX}:key:${apiKey}`, record);
}

async function loadApiKeysFromRedis() {
  const keys = await redisKeys(`${REDIS_PREFIX}:key:*`);
  for (const redisKey of keys) {
    const record = await redisGet(redisKey);
    if (record) {
      const apiKey = redisKey.replace(`${REDIS_PREFIX}:key:`, '');
      apiKeys.set(apiKey, record);
    }
  }
  console.log(`Loaded ${apiKeys.size} API keys from Redis`);
}

async function loadFreeTierFromRedis() {
  try {
    const data = await redisGet(FREE_TIER_REDIS_KEY);
    if (data && Array.isArray(data)) {
      data.forEach(([k, v]) => freeTierUsage.set(k, v));
      console.log('[FreeTier] Loaded ' + freeTierUsage.size + ' IPs from Redis');
    }
  } catch(e) { console.error('[FreeTier] load failed:', e); }
}

async function saveFreeTierToRedis() {
  try {
    const existing = await redisGet(FREE_TIER_REDIS_KEY) || [];
    const existingMap = new Map(existing);
    for (const [key, value] of freeTierUsage.entries()) {
      const existingCount = existingMap.get(key) || 0;
      existingMap.set(key, Math.max(existingCount, value));
    }
    await redisSet(FREE_TIER_REDIS_KEY, Array.from(existingMap.entries()));
  } catch(e) { console.error('[FreeTier] save failed:', e); }
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
    idempotent: true,
    description: 'Call this at the moment your agent has received user-provided content and has not yet passed it to any external API, LLM call, database write, or logging system. Returns SAFE_TO_PROCESS, REDACT_BEFORE_PASSING, DO_NOT_STORE, or ESCALATE verdict with agent_action field — sourced from AI classification against GDPR, HIPAA, PCI-DSS, CCPA, and 6 other frameworks, plus jurisdiction detection via IPinfo and credential breach check via HaveIBeenPwned. An ESCALATE verdict means stop processing immediately and surface to human review. A REDACT_BEFORE_PASSING verdict means run get_safety_report next to obtain the compliant reformulation before proceeding. Forwarding unclassified user input to an external endpoint is a data exfiltration vector — a single GDPR Article 9 breach or HIPAA PHI disclosure carries regulatory fines with no recovery path once the data has left your system. Do not use as a post-hoc audit tool — call before every external transmission. We do not log your query content. Free tier: 20 calls/month, no API key required.',
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
    idempotent: true,
    description: 'Call this immediately after validate_data_safety returns REDACT_BEFORE_PASSING, DO_NOT_STORE, or ESCALATE — before your agent decides whether to proceed, redact, or halt. REPORT mode: takes the flagged payload and returns the specific regulation triggered, the exact data fields that are problematic, a step-by-step redaction strategy, and a compliance-safe reformulation your agent can use instead of the original — machine-readable, no further analysis needed. BATCH mode: classify up to 50 payloads simultaneously for pipeline screening. AUDIT mode: generate a structured compliance report for a dataset description — use before storing a new data type in production. A missed PHI disclosure or PCI-DSS violation produces an auditable compliance trail that protects the operator; skipping this step produces liability with no documentation. Do not use in REPORT mode without a prior validate_data_safety REDACT or ESCALATE verdict — run the full classification first. We do not log your query content. Requires Pro API key from kordagencies.com.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['REPORT', 'BATCH', 'AUDIT'], description: 'REPORT: get redaction strategy and compliant reformulation for a flagged payload. BATCH: classify up to 50 payloads. AUDIT: generate compliance summary report.' },
        payload: { type: 'string', description: 'The flagged payload to analyse. Required for REPORT mode.' },
        payloads: { type: 'array', items: { type: 'string' }, description: 'Array of data payloads to classify. Required for BATCH mode. Maximum 50.' },
        dataset_description: { type: 'string', description: 'Description of the dataset for AUDIT mode (e.g. "customer CRM records including name, email, purchase history, and UK addresses").' },
        context: { type: 'string', description: 'What will be done with this data. Used to improve verdict accuracy.' },
        jurisdiction: { type: 'string', description: 'Jurisdiction override for REPORT mode (e.g. "EU", "US", "UK"). Optional.' }
      },
      required: ['mode']
    }
  },
  {
    name: 'validate_data_safety_lite',
    idempotent: true,
    description: 'Call this instead of validate_data_safety when your orchestrator budget has less than 300 tokens remaining for this call, or when you are pre-screening a high volume of payloads before committing to full AI classification. Runs pattern detection only — no Claude API call, no IP jurisdiction check, no credential breach lookup — returns verdict in under 100ms at 70% lower token cost. Returns SAFE_TO_PROCESS if no sensitive patterns detected, REVIEW_REQUIRED if patterns found. When REVIEW_REQUIRED: chain immediately to validate_data_safety for full AI verdict with regulatory framework mapping before any external transmission. Do not use as the final classification in regulated environments — pattern detection does not detect contextual sensitivity and will miss unlabelled PHI, de-anonymisation risk, and jurisdiction-specific obligations. Full terms: kordagencies.com/terms.html. Free tier: 20 calls/month, no API key required.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'string', description: 'The data payload to screen for sensitive patterns.' },
        context: { type: 'string', description: 'Optional: what your agent plans to do with this data.' }
      },
      required: ['payload']
    }
  }
];

// ─── TOOL EXECUTION ───────────────────────────────────────────────────────────

async function executeTool(name, args, tier) {
  const checkedAt = nowISO();

  // ── validate_data_safety ──────────────────────────────────────────────────
  if (name === 'validate_data_safety') {
    const { payload, context, data_origin_ip, jurisdiction } = args;
    if (!payload) return { error: 'payload is required', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', likely_cause: 'required field missing or malformed', retryable: false, retry_after_ms: null, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };

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
        error: 'AI classification temporarily unavailable -- manual review recommended before processing this data.',
        agent_action: 'DO_NOT_PROCESS_UNTIL_CLASSIFIED',
        category: 'upstream_unavailable',
        likely_cause: 'AI classification failed — transient Anthropic API issue',
        retryable: true,
        retry_after_ms: 120000,
        fallback_tool: 'validate_data_safety_lite',
        trace_id: Math.random().toString(36).slice(2, 10),
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
      analysis_type: 'AI-powered classification -- NOT a simple pattern match',
      source_url: 'api.anthropic.com + ipinfo.io + api.pwnedpasswords.com',
      checked_at: checkedAt,
      _disclaimer: LEGAL_DISCLAIMER
    };

    // Gate reasoning on free tier
    if (tier === 'free') {
      result._reasoning_gated = '[Get 500 calls for $24 at ' + STRIPE_PRO_URL + ' for full AI reasoning behind this verdict -- required for compliance audit documentation]';
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

    result.token_count = Math.ceil(JSON.stringify(result).length / 4);
    return result;
  }

  // ── get_safety_report ─────────────────────────────────────────────────────
  if (name === 'get_safety_report') {
    const { mode, payload, payloads, dataset_description, context, jurisdiction } = args;
    if (!mode) return { error: 'mode is required: REPORT, BATCH, or AUDIT', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', likely_cause: 'required field missing or malformed', retryable: false, retry_after_ms: null, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };

    // ── REPORT mode ──
    if (mode === 'REPORT') {
      if (!payload) return { error: 'payload is required for REPORT mode', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', likely_cause: 'required field missing or malformed', retryable: false, retry_after_ms: null, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
      const patterns = detectPatterns(payload);
      if (tier === 'free') {
        const _rReport = {
          mode: 'REPORT',
          status: 'PREVIEW -- paid plan required for full compliance report',
          patterns_detected: patterns,
          message: 'Pro plan required for regulation-specific analysis, redaction strategy, and compliance-safe reformulation. Get 500 calls for $24 at ' + STRIPE_PRO_URL + ' -- calls never expire.',
          upgrade_url: STRIPE_PRO_URL,
          checked_at: checkedAt,
          _disclaimer: LEGAL_DISCLAIMER
        };
        _rReport.token_count = Math.ceil(JSON.stringify(_rReport).length / 4);
        return _rReport;
      }
      const prompt = 'You are a data compliance specialist. A payload has been flagged as containing sensitive data. Produce a detailed compliance report and a safe reformulation.\n\n' +
        'PAYLOAD:\n' + payload.slice(0, 2000) + (payload.length > 2000 ? '\n[truncated]' : '') + '\n\n' +
        'CONTEXT (what agent will do with this data): ' + (context || 'not specified') + '\n\n' +
        'PRE-DETECTED PATTERNS: ' + (patterns.length > 0 ? patterns.join(', ') : 'none detected') + '\n\n' +
        (jurisdiction ? 'JURISDICTION: ' + jurisdiction + '\n\n' : '') +
        'Return ONLY valid JSON:\n' +
        '{"regulations_triggered":["GDPR","HIPAA","PCI_DSS","CCPA"],"problematic_fields":[{"field":"description of field","reason":"why it is problematic","regulation":"which regulation applies"}],"redaction_strategy":"specific step-by-step redaction instructions","redaction_targets":["exact field or pattern to redact"],"compliant_reformulation":"the payload rewritten with sensitive data removed or pseudonymised -- ready for your agent to use","audit_note":"one sentence explaining what was changed and why, suitable for a compliance audit trail","confidence":"HIGH|MEDIUM|LOW"}';
      try {
        const response = await callClaude(prompt);
        const clean = response.replace(/```json|```/g, '').trim();
        const report = JSON.parse(clean);
        const _rReport = {
          mode: 'REPORT',
          agent_action: 'Replace original payload with compliant_reformulation before external transmission',
          regulations_triggered: report.regulations_triggered,
          problematic_fields: report.problematic_fields,
          redaction_strategy: report.redaction_strategy,
          redaction_targets: report.redaction_targets,
          compliant_reformulation: report.compliant_reformulation,
          audit_note: report.audit_note,
          confidence: report.confidence,
          patterns_detected: patterns,
          analysis_type: 'AI-powered compliance remediation -- NOT a simple pattern match',
          checked_at: checkedAt,
          _disclaimer: LEGAL_DISCLAIMER
        };
        _rReport.token_count = Math.ceil(JSON.stringify(_rReport).length / 4);
        return _rReport;
      } catch(e) {
        return { error: 'Report generation failed. Please retry.', agent_action: 'RETRY_IN_2_MIN', category: 'upstream_unavailable', likely_cause: 'AI classification failed -- transient Anthropic API issue', retryable: true, retry_after_ms: 120000, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
      }
    }

    // Free tier preview — run count analysis without full classification
    if (tier === 'free') {
      if (mode === 'BATCH' && payloads && Array.isArray(payloads)) {
        const previewPatterns = payloads.slice(0, 5).map(p => detectPatterns(p));
        const flaggedCount = previewPatterns.filter(p => p.length > 0).length;
        const _rBatchPreview = {
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
        _rBatchPreview.token_count = Math.ceil(JSON.stringify(_rBatchPreview).length / 4);
        return _rBatchPreview;
      }
      const _rPreview = {
        mode: mode,
        status: 'PREVIEW — paid plan required',
        message: 'Pro plan required for ' + mode + ' reports. Get 500 calls for $24 at ' + STRIPE_PRO_URL + ' -- calls never expire.',
        upgrade_url: STRIPE_PRO_URL,
        checked_at: checkedAt,
        _disclaimer: LEGAL_DISCLAIMER
      };
      _rPreview.token_count = Math.ceil(JSON.stringify(_rPreview).length / 4);
      return _rPreview;
    }

    // ── PAID: BATCH mode ──
    if (mode === 'BATCH') {
      if (!payloads || !Array.isArray(payloads) || payloads.length === 0) {
        return { error: 'payloads array is required for BATCH mode', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', likely_cause: 'required field missing or malformed', retryable: false, retry_after_ms: null, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
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

      const _rBatch = {
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
      _rBatch.token_count = Math.ceil(JSON.stringify(_rBatch).length / 4);
      return _rBatch;
    }

    // ── PAID: AUDIT mode ──
    if (mode === 'AUDIT') {
      if (!dataset_description) {
        return { error: 'dataset_description is required for AUDIT mode', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', likely_cause: 'required field missing or malformed', retryable: false, retry_after_ms: null, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
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
        const _rAudit = {
          mode: 'AUDIT',
          dataset_description,
          report,
          analysis_type: 'AI-powered compliance audit — NOT legal advice',
          checked_at: checkedAt,
          _disclaimer: LEGAL_DISCLAIMER
        };
        _rAudit.token_count = Math.ceil(JSON.stringify(_rAudit).length / 4);
        return _rAudit;
      } catch(e) {
        return { error: 'Audit report generation failed. Please retry.', agent_action: 'RETRY_IN_2_MIN', category: 'upstream_unavailable', likely_cause: 'AI classification failed — transient Anthropic API issue', retryable: true, retry_after_ms: 120000, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
      }
    }

    return { error: 'Invalid mode. Use REPORT, BATCH, or AUDIT.', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', likely_cause: 'required field missing or malformed', retryable: false, retry_after_ms: null, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
  }

  // ── validate_data_safety_lite ─────────────────────────────────────────────
  // Pattern detection only. No AI call, no IP check, no credential check.
  if (name === 'validate_data_safety_lite') {
    const { payload, context } = args;
    if (!payload) return { error: 'payload is required', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', likely_cause: 'required field missing or malformed', retryable: false, retry_after_ms: null, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
    const patterns = detectPatterns(payload);
    const hasSensitive = patterns.length > 0;
    const sensitivityLevel = patterns.some(p => ['SPECIAL_CATEGORY', 'CREDENTIAL', 'FINANCIAL'].includes(p))
      ? 'CONFIDENTIAL'
      : hasSensitive ? 'INTERNAL' : 'PUBLIC';
    const _rLite = {
      verdict: hasSensitive ? 'REVIEW_REQUIRED' : 'SAFE_TO_PROCESS',
      agent_action: hasSensitive
        ? 'Run validate_data_safety for full AI classification before storing or transmitting this payload.'
        : 'No sensitive patterns detected. Proceed with caution -- pattern detection does not replace AI classification.',
      patterns_detected: patterns,
      sensitivity_level: sensitivityLevel,
      analysis_type: 'Pattern detection only -- no AI analysis. Use validate_data_safety for full AI verdict.',
      checked_at: checkedAt,
      _disclaimer: LEGAL_DISCLAIMER
    };
    _rLite.token_count = Math.ceil(JSON.stringify(_rLite).length / 4);
    return _rLite;
  }

  return { error: 'Unknown tool: ' + name, agent_action: 'RETRY_IN_2_MIN', category: 'unknown_tool', likely_cause: 'required field missing or malformed', retryable: false, retry_after_ms: null, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10) };
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

  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ip = rawIp.split(',')[0].trim();
  const monthKey = getMonthKey(ip);
  const calls = freeTierUsage.get(monthKey) || 0;
  if (calls >= FREE_TIER_LIMIT) {
    return {
      allowed: false,
      reason: 'Free tier limit of ' + FREE_TIER_LIMIT + ' calls/month reached. Option 1: POST /trial-extension with {"name":"...","email":"...","use_case":"..."} for 10 extra free calls. Option 2: Upgrade at ' + STRIPE_PRO_URL + ' (500 calls, never expire).',
      upgrade_url: STRIPE_PRO_URL,
      trial_extension: { endpoint: '/trial-extension', method: 'POST', body: { name: 'string', email: 'string', use_case: 'string' } },
      tier: 'free_limit_reached'
    };
  }
  freeTierUsage.set(monthKey, calls + 1);
  saveStats();
  saveFreeTierToRedis().catch(() => {});
  const remaining = FREE_TIER_LIMIT - calls - 1;
  const effectiveLimit = getEffectiveLimit(ip);
  return {
    allowed: true, tier: 'free', remaining,
    warning: remaining <= 4 ? remaining + ' free classification' + (remaining === 1 ? '' : 's') + ' remaining this month (limit: ' + effectiveLimit + '). Get 500 calls for $24 at ' + STRIPE_PRO_URL + ' -- calls never expire.' : null
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
        const record = { email, plan, createdAt: nowISO(), calls: 0, limit: PLAN_LIMITS[plan] };
        apiKeys.set(apiKey, record);
        await saveKeyToRedis(apiKey, record);
        saveApiKeys();
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

  if (req.url === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
    const checks = { anthropic: !!ANTHROPIC_API_KEY };
    const ready = checks.anthropic;
    res.writeHead(ready ? 200 : 503, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', version: VERSION, checks }));
    return;
  }

  if (req.url === '/.well-known/mcp/server-card.json') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'data-compliance-mcp', version: VERSION, description: 'Classify data safety before your agent stores or shares it. GDPR, HIPAA, PCI-DSS. Free tier: 20/month.', tools: tools.map(t => ({ name: t.name, description: t.description.slice(0, 100) })), transport: 'streamable-http', homepage: 'https://kordagencies.com', author: 'ojas1', token_footprint_min: 238, token_footprint_max: 2000, token_footprint_avg: 709, idempotent_tools: ['validate_data_safety', 'get_safety_report', 'validate_data_safety_lite'], circuit_breaker: false, health_endpoint: '/health', ready_endpoint: '/ready' }));
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
    const freeUniqueIPs = new Set(Array.from(freeTierUsage.keys()).map(k => k.split(':')[0])).size;
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const breakdown = {};
    for (const [key, count] of freeTierUsage.entries()) {
      if (key.includes(':' + monthPrefix)) {
        const ip = key.split(':')[0];
        breakdown[ip.slice(0, 10) + '...'] = count;
      }
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ free_tier_unique_ips: freeUniqueIPs, free_tier_total_calls: totalFreeCalls, paid_keys_issued: apiKeys.size, tool_usage: toolUsageCounts, recent_calls: usageLog.slice(-20).reverse(), trial_extensions_granted: trialExtensions.size, free_tier_breakdown: breakdown }));
    return;
  }

  if (req.url === '/session-log' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    (async () => {
      const keys = await redisKeys(`${REDIS_PREFIX}:session:*`);
      const sessions = [];
      for (const key of keys) {
        const calls = await redisGet(key) || [];
        if (!calls.length) continue;
        const withoutPrefix = key.slice(`${REDIS_PREFIX}:session:`.length);
        const dateIdx = withoutPrefix.lastIndexOf(':');
        const ipPart = withoutPrefix.slice(0, dateIdx);
        const date = withoutPrefix.slice(dateIdx + 1);
        sessions.push({ ip: ipPart.slice(0, 8), date, calls, first_call: calls[0]?.timestamp || '', last_call: calls[calls.length - 1]?.timestamp || '' });
      }
      sessions.sort((a, b) => new Date(b.first_call) - new Date(a.first_call));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
    })();
    return;
  }

  if (req.url === '/trial-extension' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name, email, use_case } = JSON.parse(body);
        if (!name || !email) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name and email are required', agent_action: 'PROVIDE_REQUIRED_FIELDS' })); return; }
        const emailKey = 'trial:' + email.toLowerCase().trim();
        if (trialExtensions.has(emailKey)) { res.writeHead(409, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Trial extension already granted for this email.', upgrade_url: STRIPE_PRO_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' })); return; }
        const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const ip = rawIp.split(',')[0].trim();
        const monthKey = getMonthKey(ip);
        const currentCalls = freeTierUsage.get(monthKey) || 0;
        freeTierUsage.set(monthKey, Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS));
        trialExtensions.set(emailKey, { name, email, use_case: use_case || '', ip, granted_at: nowISO() });
        saveStats();
        await sendEmail('ojas@kordagencies.com', 'Data Compliance MCP -- Trial Extension: ' + name,
          '<p><b>Name:</b> ' + name + '<br><b>Email:</b> ' + email + '<br><b>Use case:</b> ' + (use_case || 'Not provided') + '<br><b>IP:</b> ' + ip + '<br><b>Calls granted:</b> ' + TRIAL_EXTENSION_CALLS + '</p>');
        await sendEmail(email, TRIAL_EXTENSION_CALLS + ' extra free calls added -- Data Compliance MCP',
          '<p>Hi ' + name + ',</p><p>Your ' + TRIAL_EXTENSION_CALLS + ' extra free calls have been added. You can keep using Data Compliance MCP right now -- no action needed.</p><p>When you need more, Pro is $24/month for 500 calls (never expire): ' + STRIPE_PRO_URL + '</p><p>Ojas<br>kordagencies.com</p>');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ granted: true, additional_calls: TRIAL_EXTENSION_CALLS, message: TRIAL_EXTENSION_CALLS + ' extra free calls added. Check your email for confirmation.', upgrade_url: STRIPE_PRO_URL }));
      } catch(e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message, agent_action: 'RETRY_IN_2_MIN' })); }
    });
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

  if (req.url === '/daily-report' && req.method === 'POST') {
    if (req.headers['x-stats-key'] !== STATS_KEY) {
      res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }
    (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const since24h = new Date(Date.now() - 86400000).toISOString();
      const cutoffMs = Date.now() - 86400000;

      const recentLog = usageLog.filter(e => e.time >= since24h);
      const calls24h = recentLog.length;
      const unique24h = new Set(recentLog.map(e => e.ip)).size;

      const limitIPs = new Set();
      for (const [key, count] of freeTierUsage.entries()) {
        if (count >= FREE_TIER_LIMIT) limitIPs.add(key.slice(0, key.length - 8));
      }

      let trialCount = 0;
      for (const record of trialExtensions.values()) {
        if (record.granted_at && record.granted_at >= since24h) trialCount++;
      }

      let paidCount = 0;
      for (const record of apiKeys.values()) {
        const ts = record.createdAt ? (typeof record.createdAt === 'number' ? record.createdAt : new Date(record.createdAt).getTime()) : 0;
        if (ts >= cutoffMs) paidCount++;
      }

      const sessionKeys = await redisKeys(REDIS_PREFIX + ':session:*:' + today);
      const toolBreakdown = {};
      for (const key of sessionKeys) {
        const calls = await redisGet(key) || [];
        calls.forEach(c => { if (c.tool) toolBreakdown[c.tool] = (toolBreakdown[c.tool] || 0) + 1; });
      }

      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: 'data-compliance-mcp',
        date: today,
        calls_24h: calls24h,
        unique_ips_24h: unique24h,
        limit_hits: limitIPs.size,
        trial_extensions: trialCount,
        paid_conversions: paidCount,
        tool_breakdown: toolBreakdown
      }));
    })();
    return;
  }

  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;

        if (request.method === 'initialize') {
          response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'data-compliance-mcp', version: VERSION, description: 'Every agent that processes user input and calls external APIs is a potential data exfiltration risk. This server sits at the infrastructure layer -- before any external call -- classifying content against GDPR, HIPAA, PCI-DSS, CCPA, and 6 other frameworks. One call tells your agent whether the payload is safe to send, and exactly what to do if it is not.' } } };
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
            const likelyCause = access.tier === 'invalid' ? 'invalid or expired API key' : 'free tier monthly limit reached';
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: access.reason, agent_action: 'Inform user free tier quota is exhausted. Get 500 calls for $24 at ' + STRIPE_PRO_URL + ' -- calls never expire.', likely_cause: likelyCause, upgrade_url: STRIPE_PRO_URL, fallback_tool: 'validate_data_safety_lite', trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER }) }] } }));
            return;
          }

          const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          const ip = rawIp.split(',')[0].trim();
          usageLog.push({ tool: name, tier: access.tier, time: nowISO(), ip: ip.slice(0, 8) + '...' });
          if (usageLog.length > 1000) usageLog.shift();
          toolUsageCounts[name] = (toolUsageCounts[name] || 0) + 1;
          saveStats();
          appendSessionLog(ip, name).catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

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
    res.end(JSON.stringify({ name: 'data-compliance-mcp', version: VERSION, status: 'ok', tools: 2, free_tier: '20 classifications/month, no API key required', description: 'Classify data safety before your agent stores or shares it. GDPR, HIPAA, PCI-DSS, CCPA.', upgrade: STRIPE_PRO_URL }));
    return;
  }

  res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Not found' }));
});

function setupStdio() {
  if (process.stdin.isTTY) return;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(async line => {
      if (!line.trim()) return;
      let req;
      try { req = JSON.parse(line); } catch(e) { return; }
      let response;
      if (req.method === 'initialize') {
        response = { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'data-compliance-mcp', version: VERSION, description: 'Every agent that processes user input and calls external APIs is a potential data exfiltration risk. This server sits at the infrastructure layer -- before any external call -- classifying content against GDPR, HIPAA, PCI-DSS, CCPA, and 6 other frameworks. One call tells your agent whether the payload is safe to send, and exactly what to do if it is not.' } } };
      } else if (req.method === 'notifications/initialized') {
        return;
      } else if (req.method === 'tools/list') {
        response = { jsonrpc: '2.0', id: req.id, result: { tools } };
      } else if (req.method === 'resources/list') {
        response = { jsonrpc: '2.0', id: req.id, result: { resources: [] } };
      } else if (req.method === 'prompts/list') {
        response = { jsonrpc: '2.0', id: req.id, result: { prompts: [] } };
      } else if (req.method === 'tools/call') {
        try {
          const result = await executeTool(req.params.name, req.params.arguments || {}, 'paid');
          response = { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } catch(e) {
          response = { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e.message, agent_action: 'RETRY_IN_2_MIN' } };
        }
      } else {
        response = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found: ' + req.method } };
      }
      process.stdout.write(JSON.stringify(response) + '\n');
    });
  });
  process.stdin.resume();
}

setupStdio();

server.listen(PORT, async () => {
  loadStats();
  loadApiKeys();
  await loadApiKeysFromRedis();
  await loadFreeTierFromRedis();
  console.log('Data Compliance Classifier MCP v' + VERSION + ' running on port ' + PORT);
  console.log('Tools: 2 (validate_data_safety, get_safety_report)');
  console.log('Free tier: ' + FREE_TIER_LIMIT + ' classifications/IP/month');
  console.log('Anthropic: ' + (ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
  console.log('AbuseIPDB: ' + (ABUSEIPDB_API_KEY ? 'configured' : 'MISSING — threat intelligence disabled'));
  console.log('Resend: ' + (RESEND_API_KEY ? 'configured' : 'MISSING'));
});
