/**
 * Kimi 2.5 Client for Evolution
 *
 * Supports both Moonshot API (direct) and Bailian-proxied access
 */

import { randomUUID } from 'node:crypto';

// Kimi API endpoints
const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';
const BAILIAN_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1';

export interface KimiConfig {
  apiKey: string;
  model: 'kimi-k2.5' | 'qwen3-coder-plus' | 'qwen3.5-plus' | 'moonshot-v1-128k' | 'moonshot-v1-32k';
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface EvolutionProposal {
  id: string;
  description: string;
  reasoning: string;
  patch: string | null;
  simplicityScore: number;
  confidence: number;
  estimatedImpact: 'high' | 'medium' | 'low';
  suggestedTests: string[];
}

interface KimiResponse {
  id: string;
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Create a Kimi client for evolution proposals
 * Supports: kimi-k2.5, qwen3-coder-plus, qwen3.5-plus via Bailian API
 */
export function createKimiClient(config: KimiConfig) {
  // Use provided baseUrl, or default based on model
  const baseUrl = config.baseUrl || (
    config.model.startsWith('moonshot') ? MOONSHOT_BASE_URL : BAILIAN_BASE_URL
  );

  return {
    /**
     * Generate code improvement proposal
     */
    async generateProposal(params: {
      file: string;
      code: string;
      context?: string;
      goal?: string;
      previousAttempts?: string[];
    }): Promise<EvolutionProposal> {
      const systemPrompt = buildSystemPrompt();
      const userPrompt = buildUserPrompt(params);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: config.temperature ?? 0.3,
          max_tokens: config.maxTokens ?? 8192,
          // Some models require explicit JSON mode
          ...(config.model === 'kimi-k2.5' || config.model.startsWith('qwen')
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Kimi API error (${response.status}): ${error}`);
      }

      const data = await response.json() as KimiResponse;
      const content = data.choices?.[0]?.message?.content || '';

      return parseProposalResponse(content, params.file);
    },

    /**
     * Review a proposal for safety
     */
    async reviewProposal(params: {
      originalCode: string;
      proposedCode: string;
      file: string;
    }): Promise<{
      safe: boolean;
      issues: string[];
      suggestions: string[];
    }> {
      const prompt = `Review this code change for safety issues:

File: ${params.file}

ORIGINAL:
\`\`\`typescript
${params.originalCode}
\`\`\`

PROPOSED:
\`\`\`typescript
${params.proposedCode}
\`\`\`

Return JSON:
{
  "safe": boolean,
  "issues": ["list of safety concerns"],
  "suggestions": ["improvements to make it safer"]
}`;

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 2048,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        return { safe: false, issues: ['API call failed'], suggestions: [] };
      }

      const data = await response.json() as KimiResponse;
      const content = data.choices?.[0]?.message?.content || '{}';

      try {
        return JSON.parse(cleanJsonResponse(content));
      } catch {
        return { safe: true, issues: [], suggestions: [] };
      }
    },

    /**
     * Test connection
     */
    async testConnection(): Promise<boolean> {
      try {
        const response = await fetch(`${baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${config.apiKey}` },
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

function buildSystemPrompt(): string {
  return `You are an elite code evolution agent. Your task is to analyze TypeScript code and propose improvements.

PRINCIPLES:
1. SIMPLICITY: Removing code > Adding code
2. PRESERVE BEHAVIOR: No breaking changes
3. INCREMENTAL: One focused improvement at a time
4. TESTABLE: Changes must pass existing tests

PRIORITIES:
1. Remove dead code, unused imports
2. Simplify complex logic
3. Improve type safety (reduce 'any')
4. Better error handling

FORBIDDEN:
- Breaking public APIs
- Removing error handling
- Adding dependencies

You MUST respond with valid JSON only. No markdown, no explanation outside JSON.

REQUIRED JSON FORMAT:
{"description":"one-line summary","reasoning":"why this helps","patch":"improved code or NO_CHANGE","simplicityScore":0.8,"confidence":0.9,"estimatedImpact":"medium","suggestedTests":["test pattern"]}`;
}

function buildUserPrompt(params: {
  file: string;
  code: string;
  context?: string;
  goal?: string;
  previousAttempts?: string[];
}): string {
  let prompt = `FILE: ${params.file}

CODE:
${params.code}

${params.goal ? `GOAL: ${params.goal}` : 'GOAL: Improve code quality'}`;

  if (params.previousAttempts?.length) {
    prompt += `\n\nAVOID: ${params.previousAttempts.join(', ')}`;
  }

  prompt += `\n\nRespond with JSON only: {"description":"...","reasoning":"...","patch":"improved code or NO_CHANGE","simplicityScore":0.0-1.0,"confidence":0.0-1.0,"estimatedImpact":"high|medium|low","suggestedTests":["..."]}`;

  return prompt;
}

function cleanJsonResponse(content: string): string {
  let cleaned = content.trim();

  // Remove markdown code blocks
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  return cleaned;
}

function parseProposalResponse(content: string, file: string): EvolutionProposal {
  try {
    const parsed = JSON.parse(cleanJsonResponse(content));

    return {
      id: randomUUID().substring(0, 8),
      description: parsed.description || 'Code improvement',
      reasoning: parsed.reasoning || '',
      patch: parsed.patch === 'NO_CHANGE' ? null : (parsed.patch || null),
      simplicityScore: Math.min(1, Math.max(0, parsed.simplicityScore || 0.5)),
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
      estimatedImpact: parsed.estimatedImpact || 'medium',
      suggestedTests: parsed.suggestedTests || [],
    };
  } catch (error) {
    console.error('[Kimi] Failed to parse response:', content.substring(0, 200));
    return {
      id: randomUUID().substring(0, 8),
      description: 'Parse error',
      reasoning: 'Failed to parse AI response',
      patch: null,
      simplicityScore: 0,
      confidence: 0,
      estimatedImpact: 'low',
      suggestedTests: [],
    };
  }
}

/**
 * Get API key from environment
 */
export function getKimiApiKey(): string | undefined {
  return process.env.MOONSHOT_API_KEY ||
         process.env.KIMI_API_KEY ||
         process.env.BAILIAN_API_KEY;
}

/**
 * Get recommended model
 */
export function getRecommendedKimiModel(): KimiConfig['model'] {
  // Prefer kimi-k2.5 for evolution (best reasoning)
  return 'kimi-k2.5';
}
