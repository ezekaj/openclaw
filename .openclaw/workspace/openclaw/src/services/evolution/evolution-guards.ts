/**
 * Evolution Guards - Protect critical functions from auto-modification
 * 
 * Usage:
 * 1. Add @evolution:ignore JSDoc tag to protect entire function
 * 2. Add @evolution:critical for high-scrutiny (requires 2x test coverage)
 * 3. Add .evolutionignore file for path-based protection
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface GuardConfig {
  /** Functions with these JSDoc tags are protected */
  protectedTags: string[];
  /** Files matching these patterns are protected */
  protectedPatterns: string[];
  /** Functions with @evolution:critical require this many successful tests */
  criticalTestThreshold: number;
  /** Enable protection */
  enabled: boolean;
}

export interface GuardResult {
  allowed: boolean;
  reason: string;
  protectedFunction?: string;
  requiredTests?: number;
}

const DEFAULT_CONFIG: GuardConfig = {
  protectedTags: ['@evolution:ignore', '@evolution:protected', '@evolution:frozen'],
  protectedPatterns: [
    '**/neuro-memory-bridge.ts',  // Core memory - never auto-modify
    '**/event-mesh.ts',            // Event system - critical
    '**/evolution-*.ts',           // Don't let evolution modify itself
    '**/security/*.ts',            // Security code - manual review only
    '**/mcp_server.py',            // Python MCP server - delicate
  ],
  criticalTestThreshold: 2,  // @evolution:critical needs 2x test passes
  enabled: true
};

/**
 * Check if a code change is allowed
 */
export async function checkEvolutionGuard(
  proposal: { 
    description: string; 
    patches: Array<{ file: string; search: string; replace: string }>;
    affectedFiles: string[];
  },
  config: Partial<GuardConfig> = {}
): Promise<GuardResult[]> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  
  if (!finalConfig.enabled) {
    return [{ allowed: true, reason: 'Guards disabled' }];
  }

  const results: GuardResult[] = [];

  for (const patch of proposal.patches) {
    const filePath = patch.file;
    
    // 1. Check path-based protection
    const isProtectedPath = finalConfig.protectedPatterns.some(pattern => {
      const regex = pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\./g, '\\.');
      return new RegExp(regex).test(filePath);
    });

    if (isProtectedPath) {
      results.push({
        allowed: false,
        reason: `File matches protected pattern`,
        protectedFunction: filePath
      });
      continue;
    }

    // 2. Check for protected JSDoc tags in the file
    try {
      const fullPath = path.join(process.cwd(), filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      // Find which function contains the patch
      const protectedFunction = findProtectedFunction(content, patch.search);
      
      if (protectedFunction) {
        results.push({
          allowed: false,
          reason: `Function has ${protectedFunction.tag} tag`,
          protectedFunction: protectedFunction.name
        });
        continue;
      }

      // 3. Check for @evolution:critical (requires extra tests)
      const criticalFunction = findCriticalFunction(content, patch.search);
      
      if (criticalFunction) {
        results.push({
          allowed: true,
          reason: `Critical function - requires ${finalConfig.criticalTestThreshold}x test passes`,
          protectedFunction: criticalFunction,
          requiredTests: finalConfig.criticalTestThreshold
        });
        continue;
      }

      // 4. No protection - allow with normal testing
      results.push({
        allowed: true,
        reason: 'No protection detected'
      });
      
    } catch (error) {
      // File doesn't exist or can't read - allow (will fail in testing anyway)
      results.push({
        allowed: true,
        reason: 'Could not verify protection (file not found)'
      });
    }
  }

  return results;
}

/**
 * Find if a search pattern is inside a protected function
 */
function findProtectedFunction(
  content: string, 
  searchPattern: string
): { name: string; tag: string } | null {
  // Find the search pattern position
  const searchIndex = content.indexOf(searchPattern);
  if (searchIndex === -1) return null;

  // Scan backwards to find function declaration and its JSDoc
  const beforeSearch = content.substring(0, searchIndex);
  
  // Find the most recent function before this position
  const functionMatches = [...beforeSearch.matchAll(
    /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/g
  )];

  if (functionMatches.length === 0) return null;

  const lastMatch = functionMatches[functionMatches.length - 1];
  const functionName = lastMatch[1] || lastMatch[2];
  const matchStart = lastMatch.index!;

  // Check for JSDoc before the function
  const beforeFunction = beforeSearch.substring(0, matchStart);
  const jsDocMatch = beforeFunction.match(/\/\*\*[\s\S]*?\*\/\s*$/);

  if (jsDocMatch) {
    const jsDoc = jsDocMatch[0];
    
    // Check for protection tags
    for (const tag of DEFAULT_CONFIG.protectedTags) {
      if (jsDoc.includes(tag)) {
        return { name: functionName, tag };
      }
    }
  }

  return null;
}

/**
 * Find if a search pattern is inside a critical function
 */
function findCriticalFunction(content: string, searchPattern: string): string | null {
  const searchIndex = content.indexOf(searchPattern);
  if (searchIndex === -1) return null;

  const beforeSearch = content.substring(0, searchIndex);
  
  const functionMatches = [...beforeSearch.matchAll(
    /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/g
  )];

  if (functionMatches.length === 0) return null;

  const lastMatch = functionMatches[functionMatches.length - 1];
  const functionName = lastMatch[1] || lastMatch[2];
  const matchStart = lastMatch.index!;

  const beforeFunction = beforeSearch.substring(0, matchStart);
  const jsDocMatch = beforeFunction.match(/\/\*\*[\s\S]*?\*\/\s*$/);

  if (jsDocMatch && jsDocMatch[0].includes('@evolution:critical')) {
    return functionName;
  }

  return null;
}

/**
 * Load .evolutionignore file if it exists
 */
export async function loadEvolutionIgnore(baseDir: string): Promise<string[]> {
  try {
    const ignorePath = path.join(baseDir, '.evolutionignore');
    const content = await fs.readFile(ignorePath, 'utf-8');
    
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Create example .evolutionignore file
 */
export async function createExampleEvolutionIgnore(baseDir: string): Promise<void> {
  const exampleContent = `# Evolution Ignore File
# Patterns matching these paths will never be auto-modified

# Core infrastructure
src/agents/neuro-memory-bridge.ts
src/agents/event-mesh.ts
src/services/evolution/*.ts

# Security-sensitive code
src/security/*.ts
src/gateway/auth/*.ts

# MCP servers
mcp_server.py
mcp_*.py

# Test fixtures (examples, not production code)
**/*.test.ts
**/*.spec.ts
`;

  const ignorePath = path.join(baseDir, '.evolutionignore');
  await fs.writeFile(ignorePath, exampleContent, 'utf-8');
}
