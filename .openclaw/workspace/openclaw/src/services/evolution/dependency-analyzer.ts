/**
 * Dependency Analyzer for Evolution System
 *
 * Analyzes file connections BEFORE the agent starts modifying code.
 * This ensures the agent understands:
 * - Which files import/depend on the target file
 * - Which files the target file imports
 * - Public exports that MUST NOT be changed without checking callers
 *
 * This prevents breaking changes by making dependencies explicit upfront.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

export interface FileExport {
  name: string;
  kind: 'function' | 'const' | 'class' | 'interface' | 'type' | 'enum' | 'default';
  line: number;
}

export interface FileDependency {
  file: string;
  imports: string[];
  usageCount: number;
}

export interface DependencyGraph {
  targetFile: string;
  exports: FileExport[];
  importedBy: FileDependency[];
  imports: string[];
  relatedTestFiles: string[];
  summary: string;
}

/**
 * Analyze dependencies for a target file
 */
export async function analyzeDependencies(
  targetFile: string,
  workDir: string
): Promise<DependencyGraph> {
  const absolutePath = path.resolve(workDir, targetFile);
  const relativePath = path.relative(workDir, absolutePath);

  // Run all analyses in parallel
  const [exports, importedBy, imports, testFiles] = await Promise.all([
    findExports(absolutePath),
    findImporters(relativePath, workDir),
    findImports(absolutePath, workDir),
    findRelatedTests(relativePath, workDir),
  ]);

  // Build summary
  const summary = buildDependencySummary(
    relativePath,
    exports,
    importedBy,
    imports,
    testFiles
  );

  return {
    targetFile: relativePath,
    exports,
    importedBy,
    imports,
    relatedTestFiles: testFiles,
    summary,
  };
}

/**
 * Find all exports in a TypeScript file
 */
async function findExports(filePath: string): Promise<FileExport[]> {
  const exports: FileExport[] = [];

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // export function name(
      const fnMatch = line.match(/export\s+(async\s+)?function\s+(\w+)/);
      if (fnMatch) {
        exports.push({ name: fnMatch[2], kind: 'function', line: lineNum });
        continue;
      }

      // export const name =
      const constMatch = line.match(/export\s+const\s+(\w+)/);
      if (constMatch) {
        exports.push({ name: constMatch[1], kind: 'const', line: lineNum });
        continue;
      }

      // export class name
      const classMatch = line.match(/export\s+class\s+(\w+)/);
      if (classMatch) {
        exports.push({ name: classMatch[1], kind: 'class', line: lineNum });
        continue;
      }

      // export interface name
      const interfaceMatch = line.match(/export\s+interface\s+(\w+)/);
      if (interfaceMatch) {
        exports.push({ name: interfaceMatch[1], kind: 'interface', line: lineNum });
        continue;
      }

      // export type name =
      const typeMatch = line.match(/export\s+type\s+(\w+)/);
      if (typeMatch) {
        exports.push({ name: typeMatch[1], kind: 'type', line: lineNum });
        continue;
      }

      // export enum name
      const enumMatch = line.match(/export\s+enum\s+(\w+)/);
      if (enumMatch) {
        exports.push({ name: enumMatch[1], kind: 'enum', line: lineNum });
        continue;
      }

      // export default
      if (line.match(/export\s+default\s+/)) {
        exports.push({ name: 'default', kind: 'default', line: lineNum });
        continue;
      }
    }
  } catch {
    // File read error
  }

  return exports;
}

/**
 * Find all files that import the target file
 */
async function findImporters(
  relativePath: string,
  workDir: string
): Promise<FileDependency[]> {
  const importers: FileDependency[] = [];

  // Build import patterns to search for
  // e.g., src/infra/event-loop-lag.ts -> search for imports of this file
  const baseName = path.basename(relativePath, path.extname(relativePath));

  try {
    // Use ripgrep to find files that contain the module name
    // This is a broad search - we'll filter later
    const { stdout } = await exec(
      `rg -l "${baseName}" --glob "*.ts" --glob "*.tsx" 2>/dev/null || true`,
      { cwd: workDir, timeout: 30000, maxBuffer: 5 * 1024 * 1024 }
    );

    for (const file of stdout.split('\n').filter(f => f.trim())) {
      // Skip if it's the target file itself or test files
      if (file === relativePath) continue;

      // Get the actual imports used
      const imports = await getImportsFromFile(
        path.join(workDir, file),
        baseName
      );

      if (imports.length > 0) {
        const existing = importers.find(i => i.file === file);
        if (existing) {
          existing.imports = [...new Set([...existing.imports, ...imports])];
          existing.usageCount += 1;
        } else {
          importers.push({ file, imports, usageCount: 1 });
        }
      }
    }
  } catch {
    // Ripgrep not available, fall back to grep
    try {
      const { stdout } = await exec(
        `grep -rl "${baseName}" --include="*.ts" --include="*.tsx" . 2>/dev/null | head -100`,
        { cwd: workDir, timeout: 30000 }
      );

      for (const file of stdout.split('\n').filter(f => f.trim())) {
        const cleanFile = file.replace(/^\.\//, '');
        if (cleanFile === relativePath) continue;

        const imports = await getImportsFromFile(
          path.join(workDir, cleanFile),
          baseName
        );

        if (imports.length > 0) {
          importers.push({ file: cleanFile, imports, usageCount: 1 });
        }
      }
    } catch {
      // Grep also failed
    }
  }

  return importers;
}

/**
 * Get imported symbols from a file
 */
async function getImportsFromFile(
  filePath: string,
  targetBaseName: string
): Promise<string[]> {
  const imports: string[] = [];

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      // Check if this line imports from our target
      if (!line.includes(targetBaseName)) continue;

      // import { foo, bar } from '...'
      const namedMatch = line.match(/import\s*\{\s*([^}]+)\s*\}/);
      if (namedMatch) {
        const names = namedMatch[1].split(',').map(n => {
          // Handle "foo as bar" -> return "foo"
          const parts = n.trim().split(/\s+as\s+/);
          return parts[0].trim();
        });
        imports.push(...names.filter(n => n));
        continue;
      }

      // import * as foo from '...'
      const namespaceMatch = line.match(/import\s*\*\s*as\s+(\w+)/);
      if (namespaceMatch) {
        imports.push(`* as ${namespaceMatch[1]}`);
        continue;
      }

      // import foo from '...'
      const defaultMatch = line.match(/import\s+(\w+)\s+from/);
      if (defaultMatch && !line.includes('{')) {
        imports.push(`default as ${defaultMatch[1]}`);
        continue;
      }
    }
  } catch {
    // File read error
  }

  return imports;
}

/**
 * Find what the target file imports
 */
async function findImports(
  filePath: string,
  workDir: string
): Promise<string[]> {
  const imports: string[] = [];

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      // import ... from '...'
      const importMatch = line.match(/import.*from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const importPath = importMatch[1];
        // Resolve relative paths
        if (importPath.startsWith('.')) {
          const resolved = path.resolve(
            path.dirname(filePath),
            importPath
          );
          const relativeTo = path.relative(workDir, resolved);
          // Add .ts extension if not present
          const withExt = relativeTo.endsWith('.ts') || relativeTo.endsWith('.js')
            ? relativeTo
            : `${relativeTo}.ts`;
          imports.push(withExt);
        } else {
          // External package
          imports.push(importPath);
        }
      }
    }
  } catch {
    // File read error
  }

  return imports;
}

/**
 * Find related test files
 */
async function findRelatedTests(
  relativePath: string,
  workDir: string
): Promise<string[]> {
  const tests: string[] = [];
  const baseName = path.basename(relativePath, path.extname(relativePath));
  const dirName = path.dirname(relativePath);

  // Common test file patterns
  const patterns = [
    `${baseName}.test.ts`,
    `${baseName}.spec.ts`,
    `__tests__/${baseName}.ts`,
    `__tests__/${baseName}.test.ts`,
  ];

  for (const pattern of patterns) {
    const testPath = path.join(dirName, pattern);
    try {
      await fs.access(path.join(workDir, testPath));
      tests.push(testPath);
    } catch {
      // Test file doesn't exist
    }
  }

  // Also search for test files that import this module
  try {
    const { stdout } = await exec(
      `rg -l "${baseName}" --glob "*.test.ts" --glob "*.spec.ts" 2>/dev/null | head -10`,
      { cwd: workDir, timeout: 15000 }
    );

    for (const file of stdout.split('\n').filter(f => f.trim())) {
      if (!tests.includes(file)) {
        tests.push(file);
      }
    }
  } catch {
    // Search failed
  }

  return tests;
}

/**
 * Build a human-readable summary of dependencies
 */
function buildDependencySummary(
  targetFile: string,
  exports: FileExport[],
  importedBy: FileDependency[],
  imports: string[],
  testFiles: string[]
): string {
  const lines: string[] = [];

  lines.push(`## DEPENDENCY ANALYSIS: ${targetFile}`);
  lines.push('');

  // Exports (API surface)
  if (exports.length > 0) {
    lines.push('### Public API (DO NOT BREAK without checking callers):');
    for (const exp of exports) {
      lines.push(`  - ${exp.kind} \`${exp.name}\` (line ${exp.line})`);
    }
    lines.push('');
  }

  // Files that import this (CRITICAL - these will break if you change exports)
  if (importedBy.length > 0) {
    lines.push(`### Files that IMPORT this module (${importedBy.length} files):`);
    lines.push('⚠️ CRITICAL: Changes to exports will break these files!');
    for (const dep of importedBy.slice(0, 20)) {
      lines.push(`  - ${dep.file}`);
      lines.push(`    Uses: ${dep.imports.join(', ')}`);
    }
    if (importedBy.length > 20) {
      lines.push(`  ... and ${importedBy.length - 20} more files`);
    }
    lines.push('');
  } else {
    lines.push('### Files that IMPORT this module: None found');
    lines.push('(Safe to refactor exports if no importers)');
    lines.push('');
  }

  // What this file imports
  if (imports.length > 0) {
    const localImports = imports.filter(i => !i.includes('node_modules') && !i.startsWith('@'));
    const externalImports = imports.filter(i => i.includes('node_modules') || i.startsWith('@') || !i.includes('/'));

    if (localImports.length > 0) {
      lines.push('### Local dependencies (files this imports):');
      for (const imp of localImports) {
        lines.push(`  - ${imp}`);
      }
      lines.push('');
    }

    if (externalImports.length > 0) {
      lines.push('### External packages:');
      for (const imp of externalImports.slice(0, 10)) {
        lines.push(`  - ${imp}`);
      }
      lines.push('');
    }
  }

  // Test files
  if (testFiles.length > 0) {
    lines.push('### Related test files:');
    for (const test of testFiles) {
      lines.push(`  - ${test}`);
    }
    lines.push('');
  } else {
    lines.push('### Related test files: None found');
    lines.push('Consider creating tests before making changes!');
    lines.push('');
  }

  // Safety warnings
  lines.push('### SAFETY RULES:');
  if (importedBy.length > 0) {
    lines.push('1. ❌ DO NOT rename or remove exported functions/types without updating callers');
    lines.push('2. ❌ DO NOT change function signatures (parameters, return types) of exports');
    lines.push('3. ✅ SAFE to refactor internal (non-exported) code');
    lines.push('4. ✅ SAFE to add new exports');
  } else {
    lines.push('1. ✅ No importers found - exports can be safely refactored');
    lines.push('2. ✅ Internal refactoring is safe');
  }

  return lines.join('\n');
}

/**
 * Quick check if a change would break callers
 */
export function wouldBreakCallers(
  graph: DependencyGraph,
  changedExports: string[]
): { breaking: boolean; affected: FileDependency[] } {
  const affected: FileDependency[] = [];

  for (const dep of graph.importedBy) {
    const usedExports = dep.imports.filter(i =>
      changedExports.some(e => i === e || i.startsWith(`${e} `))
    );
    if (usedExports.length > 0) {
      affected.push(dep);
    }
  }

  return {
    breaking: affected.length > 0,
    affected,
  };
}
