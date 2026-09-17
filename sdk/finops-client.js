// finops-client.js - a thin wrapper so developers don't hand-manage proxy
// headers on every call. Zero dependencies - just wraps fetch.
//
// Usage:
//   const { FinOpsClient } = require('./finops-client');
//   const client = new FinOpsClient({
//     baseUrl: 'http://localhost:4000',
//     apiKey: 'fk_...',        // your platform API key
//     providerKey: 'sk-...',   // your real OpenAI/Anthropic key
//     team: 'growth',
//     environment: 'prod',
//   });
//
//   const response = await client.chat('openai', {
//     model: 'gpt-4o-mini',
//     messages: [{ role: 'user', content: 'hello' }],
//   });
//
//   // Streaming:
//   for await (const chunk of client.chatStream('openai', { model: 'gpt-4o-mini', messages: [...] })) {
//     process.stdout.write(chunk);
//   }
//
//   // Opt-in caching (exact-match, see server/cache.js for scope/limits):
//   await client.chat('openai', body, { cache: true, cacheTtlSeconds: 600 });

class FinOpsClient {
  constructor({ baseUrl, apiKey, providerKey, team, environment, gitBranch }) {
    if (!baseUrl) throw new Error("FinOpsClient requires baseUrl");
    if (!apiKey) throw new Error("FinOpsClient requires apiKey");
    if (!providerKey) throw new Error("FinOpsClient requires providerKey");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.providerKey = providerKey;
    this.team = team;
    this.environment = environment;
    this.gitBranch = gitBranch;
  }

  _headers(extra = {}) {
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
      "X-Provider-Key": this.providerKey,
      ...extra,
    };
    if (this.team) headers["X-Team"] = this.team;
    if (this.environment) headers["X-Environment"] = this.environment;
    if (this.gitBranch) headers["X-Git-Branch"] = this.gitBranch;
    return headers;
  }

  async chat(provider, body, { cache = false, cacheTtlSeconds } = {}) {
    const extraHeaders = {};
    if (cache) extraHeaders["X-Enable-Cache"] = "true";
    if (cacheTtlSeconds) extraHeaders["X-Cache-TTL-Seconds"] = String(cacheTtlSeconds);

    const res = await fetch(`${this.baseUrl}/api/proxy/${provider}`, {
      method: "POST",
      headers: this._headers(extraHeaders),
      body: JSON.stringify({ ...body, stream: false }),
    });

    const json = await res.json();
    if (!res.ok) {
      const err = new Error(json.error?.message || json.error || `Request failed: ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async *chatStream(provider, body) {
    const res = await fetch(`${this.baseUrl}/api/proxy/${provider}`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const err = new Error(json.error?.message || json.error || `Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      yield decoder.decode(chunk, { stream: true });
    }
  }
}

module.exports = { FinOpsClient };
