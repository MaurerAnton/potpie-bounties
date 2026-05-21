/**
 * EdgeChains #286 — Smart Router like litellm (TypeScript)
 * Features: load balancing, streaming, token tracking, logging
 */

import axios, { AxiosInstance, AxiosResponse } from "axios";
import * as Sentry from "@sentry/node";

// ═══════════════════════════════════════════════════════════════════════
// 1. Smart Router with load balancing
// ═══════════════════════════════════════════════════════════════════════

interface Deployment {
  name: string;
  provider: "openai" | "google" | "cohere";
  apiKey: string;
  baseURL: string;
  rateLimitRPM: number;
  rateLimitTPM: number;
  tokensUsedThisMinute: number;
  requestsThisMinute: number;
  lastResetTime: number;
  cooldownUntil: number;
}

class SmartRouter {
  private deployments: Deployment[] = [];
  private static instance: SmartRouter;

  static getInstance(): SmartRouter {
    if (!SmartRouter.instance) SmartRouter.instance = new SmartRouter();
    return SmartRouter.instance;
  }

  addDeployment(dep: Deployment): void {
    this.deployments.push(dep);
  }

  /** Pick the best deployment: under rate limit, least tokens used. */
  private pickDeployment(): Deployment {
    const now = Date.now();
    const available = this.deployments.filter(d => {
      if (d.cooldownUntil > now) return false;
      if (now - d.lastResetTime > 60000) {
        d.tokensUsedThisMinute = 0;
        d.requestsThisMinute = 0;
        d.lastResetTime = now;
      }
      return d.requestsThisMinute < d.rateLimitRPM && d.tokensUsedThisMinute < d.rateLimitTPM;
    });

    if (available.length === 0) {
      throw new Error("All deployments are rate-limited. Retry later.");
    }

    // Pick deployment with least tokens used (load balancing)
    return available.sort((a, b) => a.tokensUsedThisMinute - b.tokensUsedThisMinute)[0];
  }

  recordUsage(dep: Deployment, tokens: number): void {
    dep.tokensUsedThisMinute += tokens;
    dep.requestsThisMinute++;
  }

  cooldown(dep: Deployment, seconds: number = 60): void {
    dep.cooldownUntil = Date.now() + seconds * 1000;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 2. LLM Client with retry/timeout/streaming
// ═══════════════════════════════════════════════════════════════════════

interface LLMRequest {
  provider: string;
  model: string;
  messages?: { role: string; content: string }[];
  prompt?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface LLMResponse {
  text: string;
  tokens: { prompt: number; completion: number; total: number };
  model: string;
  deployment: string;
}

class LiteLLMClient {
  private router = SmartRouter.getInstance();
  private maxRetries = 3;
  private timeoutMs = 30000;

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const dep = this.router.pickDeployment();
    const client = this.createClient(dep);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const resp = await this.sendRequest(client, dep, req);
        this.router.recordUsage(dep, resp.tokens.total);
        Sentry.addBreadcrumb({ message: `LLM call to ${dep.name}`, data: { tokens: resp.tokens.total } });
        return resp;
      } catch (e: any) {
        if (attempt === this.maxRetries) {
          this.router.cooldown(dep, 30);
          throw e;
        }
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw new Error("Unreachable");
  }

  async *stream(req: LLMRequest): AsyncGenerator<string> {
    const dep = this.router.pickDeployment();
    const client = this.createClient(dep);
    req.stream = true;

    try {
      const resp = await this.sendStreamRequest(client, dep, req);
      let totalTokens = 0;
      for await (const chunk of resp) {
        totalTokens += this.countTokens(chunk);
        yield chunk;
      }
      this.router.recordUsage(dep, totalTokens);
    } catch (e: any) {
      this.router.cooldown(dep, 10);
      throw e;
    }
  }

  private createClient(dep: Deployment): AxiosInstance {
    const client = axios.create({ baseURL: dep.baseURL, timeout: this.timeoutMs });
    client.defaults.headers.common["Authorization"] = `Bearer ${dep.apiKey}`;

    // Reliability: retry + timeout via interceptors
    client.interceptors.response.use(
      (r: AxiosResponse) => r,
      async (error) => {
        if (error.code === "ECONNABORTED") throw new Error("Request timeout");
        if (error.response?.status === 429) throw new Error("Rate limited");
        throw error;
      }
    );
    return client;
  }

  private async sendRequest(client: AxiosInstance, dep: Deployment, req: LLMRequest): Promise<LLMResponse> {
    const url = this.buildURL(dep.provider);
    const body = this.buildBody(dep.provider, req);
    const resp = await client.post(url, body);
    return this.parseResponse(dep.provider, dep.name, resp.data);
  }

  private async sendStreamRequest(client: AxiosInstance, dep: Deployment, req: LLMRequest): Promise<AsyncGenerator<string>> {
    const url = this.buildURL(dep.provider);
    const body = { ...this.buildBody(dep.provider, req), stream: true };
    const resp = await client.post(url, body, { responseType: "stream" });
    return this.parseStream(dep.provider, resp.data);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. Token counting
  // ═══════════════════════════════════════════════════════════════════

  countTokens(text: string): number {
    return Math.ceil(text.length / 4); // rough estimate
  }

  // ═══════════════════════════════════════════════════════════════════
  // Provider-specific helpers
  // ═══════════════════════════════════════════════════════════════════

  private buildURL(provider: string): string {
    switch (provider) {
      case "openai": return "/v1/chat/completions";
      case "google": return "/v1/models/gemini-pro:generateContent";
      case "cohere": return "/v1/chat";
      default: throw new Error(`Unknown provider: ${provider}`);
    }
  }

  private buildBody(provider: string, req: LLMRequest): any {
    switch (provider) {
      case "openai": return {
        model: req.model,
        messages: req.messages,
        max_tokens: req.max_tokens,
        temperature: req.temperature,
      };
      case "google": return {
        contents: [{ parts: [{ text: req.prompt || req.messages?.map(m => m.content).join("\n") }] }],
        generationConfig: { maxOutputTokens: req.max_tokens, temperature: req.temperature },
      };
      case "cohere": return {
        model: req.model,
        message: req.prompt || req.messages?.map(m => m.content).join("\n"),
        max_tokens: req.max_tokens,
        temperature: req.temperature,
      };
      default: throw new Error(`Unknown provider: ${provider}`);
    }
  }

  private parseResponse(provider: string, depName: string, data: any): LLMResponse {
    switch (provider) {
      case "openai": return {
        text: data.choices[0].message.content,
        tokens: { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens, total: data.usage.total_tokens },
        model: data.model, deployment: depName,
      };
      case "google": return {
        text: data.candidates[0].content.parts[0].text,
        tokens: {
          prompt: data.usageMetadata?.promptTokenCount || this.countTokens(data.candidates[0].content.parts[0].text),
          completion: data.usageMetadata?.candidatesTokenCount || 0,
          total: data.usageMetadata?.totalTokenCount || 0,
        },
        model: "gemini-pro", deployment: depName,
      };
      case "cohere": return {
        text: data.text,
        tokens: {
          prompt: data.meta?.billed_units?.input_tokens || 0,
          completion: data.meta?.billed_units?.output_tokens || 0,
          total: (data.meta?.billed_units?.input_tokens || 0) + (data.meta?.billed_units?.output_tokens || 0),
        },
        model: req.model, deployment: depName,
      };
      default: return { text: "", tokens: { prompt: 0, completion: 0, total: 0 }, model: "", deployment: "" };
    }
  }

  private async *parseStream(provider: string, stream: any): AsyncGenerator<string> {
    for await (const chunk of stream) {
      const lines = chunk.toString().split("\n").filter((l: string) => l.startsWith("data: "));
      for (const line of lines) {
        const data = JSON.parse(line.slice(6));
        if (data === "[DONE]") return;
        switch (provider) {
          case "openai": yield data.choices[0]?.delta?.content || ""; break;
          case "google": yield data.candidates[0]?.content?.parts[0]?.text || ""; break;
          case "cohere": if (data.event_type === "text-generation") yield data.text || ""; break;
        }
      }
    }
  }
}

export { SmartRouter, LiteLLMClient, Deployment, LLMRequest, LLMResponse };
