/**
 * Task Complexity Detection
 * 
 * Analyzes browser actions to determine task complexity.
 * Used for smart routing between Lightpanda (fast) and Chromium (compatible).
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("task-complexity");

// ============================================================================
// TYPES
// ============================================================================

export type TaskComplexity = "simple" | "moderate" | "complex";

export interface TaskAnalysis {
  complexity: TaskComplexity;
  hints: string[];
  recommendedEngine: "lightpanda" | "chromium" | "auto";
  confidence: number; // 0-1
  reasoning: string[];
}

export interface TaskContext {
  action: string;
  url?: string;
  request?: Record<string, unknown>;
  profile?: string;
  selector?: string;
  expression?: string;
}

// ============================================================================
// COMPLEXITY HEURISTICS
// ============================================================================

/**
 * Simple tasks: Lightpanda preferred (9x faster, 9x less memory)
 * - Static page scraping
 * - Screenshots
 * - Simple navigation
 * - Basic form interactions
 */
const SIMPLE_TASK_INDICATORS = {
  actions: [
    "screenshot",
    "ocr",
    "vision",
    "pdf",
  ],
  
  urlPatterns: [
    // Static content sites
    /\.(html?|pdf|txt|json|xml)$/i,
    /wiki/,
    /blog/,
    /docs\./,
    /documentation/,
    
    // Simple pages
    /about/,
    /contact/,
    /pricing/,
    /faq/,
  ],
  
  selectors: [
    // Basic HTML elements
    /^#/,
    /^\.[a-z-]+$/,
    /^[a-z]+$/, // tag names
  ],
};

/**
 * Moderate tasks: Either engine works
 * - Dynamic content (some JS)
 * - Forms with validation
 * - Pages with ads/trackers
 */
const MODERATE_TASK_INDICATORS = {
  actions: [
    "snapshot",
    "navigate",
    "act", // clicks, typing
    "upload",
    "dialog",
  ],
  
  urlPatterns: [
    // Dynamic but not SPA
    /\?.*=/, // query params
    /search/,
    /filter/,
    /category/,
    
    // Known moderate sites
    /amazon\.com/,
    /ebay\.com/,
    /craigslist/,
  ],
  
  domPatterns: [
    // Moderate DOM complexity
    /class=".*\b(js|ajax|dynamic|lazy)\b.*"/i,
  ],
};

/**
 * Complex tasks: Chromium required (full Web API support)
 * - Single-page applications
 * - Heavy JavaScript
 * - WebSocket/WebRTC
 * - Chrome extensions
 * - Advanced user interactions
 */
const COMPLEX_TASK_INDICATORS = {
  actions: [
    // No specific action, detected via context
  ],
  
  urlPatterns: [
    // SPAs
    /app\./,
    /dashboard/,
    /portal/,
    /admin/,
    
    // Known SPA frameworks
    /react/i,
    /vue/i,
    /angular/i,
    /next\./i,
    /nuxt\./i,
    
    // Heavy JS sites
    /twitter\.com/,
    /facebook\.com/,
    /youtube\.com/,
    /linkedin\.com/,
    /github\.com/,
    /notion\.so/,
    /figma\.com/,
    /slack\.com/,
    /discord/,
    /spotify\.com/,
    /netflix\.com/,
    
    // Real-time apps
    /chat/,
    /live/,
    /stream/,
    /collab/,
  ],
  
  expressions: [
    // Complex evaluate() calls
    /WebSocket/i,
    /WebRTC/i,
    /IndexedDB/i,
    /ServiceWorker/i,
    /WebGL/i,
    /Canvas/i,
    /Worker/i,
    /SharedArrayBuffer/i,
    /Proxy/i,
    /Reflect/i,
    /CustomElement/i,
    /MutationObserver/i,
    /IntersectionObserver/i,
    /ResizeObserver/i,
  ],
  
  selectors: [
    // Complex selectors
    /\[data-/, // data attributes (framework generated)
    /:nth-child/,
    /:nth-of-type/,
    /::/, // pseudo-elements
    />/, // child combinators (deep DOM)
    /\+.*/, // sibling combinators
  ],
  
  profiles: [
    "chrome", // Extension relay always requires Chromium
  ],
};

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

/**
 * Analyze task complexity from action context
 */
export function analyzeTaskComplexity(ctx: TaskContext): TaskAnalysis {
  const hints: string[] = [];
  const reasoning: string[] = [];
  let complexityScore = 0; // -10 to +10 scale

  // 1. Check action type
  if (SIMPLE_TASK_INDICATORS.actions.includes(ctx.action)) {
    complexityScore -= 5;
    hints.push("simple-action");
    reasoning.push(`Action '${ctx.action}' is typically simple`);
  }

  if (MODERATE_TASK_INDICATORS.actions.includes(ctx.action)) {
    complexityScore += 0;
    hints.push("moderate-action");
    reasoning.push(`Action '${ctx.action}' is moderate complexity`);
  }

  // 2. Check profile (Chrome extension relay)
  if (ctx.profile && COMPLEX_TASK_INDICATORS.profiles.includes(ctx.profile)) {
    complexityScore += 10; // Always use Chromium
    hints.push("chrome-extension-relay");
    reasoning.push("Chrome extension relay requires Chromium");
  }

  // 3. Check URL patterns
  if (ctx.url) {
    const url = ctx.url.toLowerCase();

    // Simple URL patterns
    for (const pattern of SIMPLE_TASK_INDICATORS.urlPatterns) {
      if (pattern.test(url)) {
        complexityScore -= 2;
        hints.push("simple-url-pattern");
        reasoning.push(`URL matches simple pattern: ${pattern}`);
        break;
      }
    }

    // Moderate URL patterns
    for (const pattern of MODERATE_TASK_INDICATORS.urlPatterns) {
      if (pattern.test(url)) {
        complexityScore += 1;
        hints.push("moderate-url-pattern");
        reasoning.push(`URL matches moderate pattern: ${pattern}`);
        break;
      }
    }

    // Complex URL patterns
    for (const pattern of COMPLEX_TASK_INDICATORS.urlPatterns) {
      if (pattern.test(url)) {
        complexityScore += 3;
        hints.push("complex-url-pattern");
        reasoning.push(`URL matches complex SPA pattern: ${pattern}`);
        break;
      }
    }
  }

  // 4. Check selector complexity
  if (ctx.selector) {
    // Simple selectors
    for (const pattern of SIMPLE_TASK_INDICATORS.selectors) {
      if (pattern.test(ctx.selector)) {
        complexityScore -= 1;
        hints.push("simple-selector");
        reasoning.push(`Selector is simple: ${ctx.selector}`);
        break;
      }
    }

    // Complex selectors
    for (const pattern of COMPLEX_TASK_INDICATORS.selectors) {
      if (pattern.test(ctx.selector)) {
        complexityScore += 2;
        hints.push("complex-selector");
        reasoning.push(`Selector is complex: ${ctx.selector}`);
        break;
      }
    }
  }

  // 5. Check JavaScript expression complexity
  if (ctx.expression) {
    for (const pattern of COMPLEX_TASK_INDICATORS.expressions) {
      if (pattern.test(ctx.expression)) {
        complexityScore += 4;
        hints.push("complex-expression");
        reasoning.push(`Expression uses advanced API: ${pattern}`);
      }
    }
  }

  // 6. Check request complexity (for act actions)
  if (ctx.request) {
    const req = ctx.request;
    
    // Multiple fields = complex form
    if (req.fields && Array.isArray(req.fields) && req.fields.length > 3) {
      complexityScore += 1;
      hints.push("complex-form");
      reasoning.push(`Form has ${req.fields.length} fields`);
    }

    // Drag/drop = complex interaction
    if (req.kind === "drag") {
      complexityScore += 2;
      hints.push("complex-interaction");
      reasoning.push("Drag-and-drop is complex interaction");
    }
  }

  // 7. Special cases
  if (ctx.action === "navigate" && ctx.url) {
    // Check if it's an SPA framework URL
    if (COMPLEX_TASK_INDICATORS.urlPatterns.some(p => p.test(ctx.url!.toLowerCase()))) {
      complexityScore += 2;
      hints.push("spa-navigation");
      reasoning.push("Navigation to SPA");
    }
  }

  // Calculate final complexity
  let complexity: TaskComplexity;
  if (complexityScore <= -3) {
    complexity = "simple";
  } else if (complexityScore >= 3) {
    complexity = "complex";
  } else {
    complexity = "moderate";
  }

  // Recommend engine
  let recommendedEngine: "lightpanda" | "chromium" | "auto";
  if (complexity === "simple") {
    recommendedEngine = "lightpanda";
  } else if (complexity === "complex") {
    recommendedEngine = "chromium";
  } else {
    recommendedEngine = "auto";
  }

  // Calculate confidence (0-1)
  const confidence = Math.min(1, Math.abs(complexityScore) / 10);

  log.debug("Task analysis complete", {
    action: ctx.action,
    complexity,
    score: complexityScore,
    recommendedEngine,
    confidence,
    hints,
  });

  return {
    complexity,
    hints,
    recommendedEngine,
    confidence,
    reasoning,
  };
}

/**
 * Quick check if task should use Lightpanda
 */
export function shouldUseLightpanda(ctx: TaskContext): boolean {
  const analysis = analyzeTaskComplexity(ctx);
  
  // Simple tasks with high confidence -> Lightpanda
  if (analysis.complexity === "simple" && analysis.confidence >= 0.5) {
    return true;
  }

  // Moderate tasks with auto recommendation
  if (analysis.complexity === "moderate" && analysis.recommendedEngine === "auto") {
    return true; // Give Lightpanda a try with fallback
  }

  return false;
}

/**
 * Quick check if task requires Chromium
 */
export function requiresChromium(ctx: TaskContext): boolean {
  const analysis = analyzeTaskComplexity(ctx);
  
  // Chrome extension relay
  if (ctx.profile === "chrome") {
    return true;
  }

  // Complex tasks with high confidence
  if (analysis.complexity === "complex" && analysis.confidence >= 0.6) {
    return true;
  }

  return false;
}

/**
 * Get task hint from context (for router)
 */
export function getTaskHint(ctx: TaskContext): string | undefined {
  const analysis = analyzeTaskComplexity(ctx);
  
  // Return first hint, or undefined
  return analysis.hints[0];
}
