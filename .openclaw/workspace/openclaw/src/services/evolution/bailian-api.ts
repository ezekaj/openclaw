/**
 * Bailian API client for evolution proposals
 * 
 * Supports: qwen3.5-plus, qwen3-max, qwen3-coder-plus, glm-5, MiniMax, kimi
 * OpenAI-compatible API
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

const BAILIAN_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1';

interface EvolutionProposalRequest {
  model: string;
  file: string;
  code: string;
  goal: string;
}

interface EvolutionProposal {
  id: string;
  description: string;
  patch: string | null;
  simplicityScore: number;
  reasoning: string;
}

/**
 * Generate code improvement proposal using Bailian API
 */
export async function generateEvolutionProposal(
  request: EvolutionProposalRequest
): Promise<EvolutionProposal> {
  const apiKey = process.env.BAILIAN_API_KEY;
  
  if (!apiKey) {
    throw new Error('BAILIAN_API_KEY environment variable not set');
  }
  
  const systemPrompt = `You are an autonomous code evolution agent. Your goal is to improve code quality.

RULES:
1. Generate unified diff patches to improve the code
2. Focus on: performance, simplicity, maintainability
3. Simpler is better: removing code > adding code
4. Return ONLY valid unified diff format
5. If no improvement needed, return "NO_CHANGE"

METRICS:
- Simplicity: (lines_removed - lines_added) / 100
- Prefer deletions over additions
- Equal performance + simpler = keep

OUTPUT FORMAT (JSON):
{
  "description": "Brief description of change",
  "reasoning": "Why this improves the code",
  "patch": "unified diff or NO_CHANGE",
  "simplicityScore": 0.0-1.0
}`;

  const userPrompt = `File: ${request.file}

Goal: ${request.goal}

Current code:
\`\`\`typescript
${request.code}
\`\`\`

Analyze and propose improvements. Return JSON only.`;

  try {
    const response = await fetch(`${BAILIAN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 8192
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bailian API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    
    // Parse JSON response
    const proposal = parseProposalResponse(content);
    
    return {
      id: randomUUID().substring(0, 7),
      description: proposal.description,
      patch: proposal.patch === 'NO_CHANGE' ? null : proposal.patch,
      simplicityScore: proposal.simplicityScore || 0.5,
      reasoning: proposal.reasoning
    };
  } catch (error) {
    console.error('[Bailian API] Error:', error);
    throw error;
  }
}

/**
 * Parse proposal response (handle markdown code blocks)
 */
function parseProposalResponse(content: string): {
  description: string;
  reasoning: string;
  patch: string;
  simplicityScore: number;
} {
  // Remove markdown code blocks if present
  let cleaned = content.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Fallback: try to extract from unstructured response
    return {
      description: 'API response parsing failed',
      reasoning: content.substring(0, 200),
      patch: 'NO_CHANGE',
      simplicityScore: 0.0
    };
  }
}

/**
 * Test API connection
 */
export async function testBailianConnection(): Promise<boolean> {
  const apiKey = process.env.BAILIAN_API_KEY;
  
  if (!apiKey) {
    console.error('BAILIAN_API_KEY not set');
    return false;
  }
  
  try {
    const response = await fetch(`${BAILIAN_BASE_URL}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    if (response.ok) {
      console.log('✓ Bailian API connection successful');
      return true;
    } else {
      console.error('✗ Bailian API connection failed:', response.status);
      return false;
    }
  } catch (error) {
    console.error('✗ Bailian API connection error:', error);
    return false;
  }
}

/**
 * Get available models
 */
export function getAvailableModels(): string[] {
  return [
    'qwen3.5-plus',           // 1M context, fast
    'qwen3-max-2026-01-23',   // 262K context, powerful
    'qwen3-coder-next',       // 262K context, code-focused
    'qwen3-coder-plus',       // 1M context, code-focused (RECOMMENDED)
    'MiniMax-M2.5',           // 196K context
    'glm-5',                  // 202K context
    'glm-4.7',                // 202K context
    'kimi-k2.5'               // 262K context, multimodal
  ];
}

/**
 * Get recommended model for code evolution
 */
export function getRecommendedModel(): string {
  // qwen3-coder-plus has 1M context + code optimization
  return 'qwen3-coder-plus';
}
