/**
 * Evolution Tools - Agentic capabilities for the evolution daemon
 *
 * Gives Kimi K2.5 the power to:
 * - Read files from the codebase
 * - Search for patterns (grep)
 * - Fetch documentation from the web
 * - Run tests to validate changes
 * - Check git history for context
 * - Execute shell commands (sandboxed)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  extractReadableContent,
  htmlToMarkdown,
} from '../../agents/tools/web-fetch-utils.js';

// Tool argument types for better type safety
type ToolArgs = Record<string, unknown>;

const exec = promisify(execCallback);

// Tool definitions for OpenAI-compatible API
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description: string;
        enum?: string[];
      }>;
      required: string[];
    };
  };
}

// Tool call from model response
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// Message types
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// Tool executor context
export interface ToolContext {
  workDir: string;
  maxFileSize: number;
  maxSearchResults: number;
  timeout: number;
}

/**
 * All available tools for the evolution agent
 */
export function getEvolutionTools(): ToolDefinition[] {
  return [
    // 1. Read file
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file from the codebase. Use this to understand code before proposing changes.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path to the file (e.g., "src/utils/helpers.ts")'
            },
            start_line: {
              type: 'number',
              description: 'Optional: Start reading from this line (1-indexed)'
            },
            end_line: {
              type: 'number',
              description: 'Optional: Stop reading at this line'
            }
          },
          required: ['path']
        }
      }
    },

    // 2. Search codebase (grep)
    {
      type: 'function',
      function: {
        name: 'search_code',
        description: 'Search for patterns in the codebase using regex. Returns matching files and lines.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Regex pattern to search for'
            },
            file_glob: {
              type: 'string',
              description: 'File pattern to search in (e.g., "*.ts", "src/**/*.ts")'
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return (default: 20)'
            }
          },
          required: ['pattern']
        }
      }
    },

    // 3. List files
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in a directory. Use this to explore the codebase structure.',
        parameters: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Directory path relative to workspace root (e.g., "src/services")'
            },
            pattern: {
              type: 'string',
              description: 'Optional glob pattern filter (e.g., "*.ts")'
            },
            recursive: {
              type: 'string',
              description: 'Search recursively ("true" or "false", default: "false")'
            }
          },
          required: ['directory']
        }
      }
    },

    // 4. Fetch web documentation
    {
      type: 'function',
      function: {
        name: 'fetch_docs',
        description: 'Fetch documentation from a URL. Use this to look up API docs, npm package info, or best practices.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to fetch (supports npm packages like "npm:lodash", or full URLs)'
            },
            query: {
              type: 'string',
              description: 'Optional: What specific information to extract'
            }
          },
          required: ['url']
        }
      }
    },

    // 5. Run tests
    {
      type: 'function',
      function: {
        name: 'run_tests',
        description: 'Run tests to validate code changes. Can run all tests or specific test files.',
        parameters: {
          type: 'object',
          properties: {
            test_file: {
              type: 'string',
              description: 'Optional: Specific test file to run (e.g., "src/utils/helpers.test.ts")'
            },
            pattern: {
              type: 'string',
              description: 'Optional: Test name pattern to match'
            }
          },
          required: []
        }
      }
    },

    // 6. Git history
    {
      type: 'function',
      function: {
        name: 'git_history',
        description: 'Get git history for a file or directory. Useful for understanding recent changes and context.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File or directory path to get history for'
            },
            limit: {
              type: 'number',
              description: 'Number of commits to show (default: 10)'
            }
          },
          required: []
        }
      }
    },

    // 7. Git diff
    {
      type: 'function',
      function: {
        name: 'git_diff',
        description: 'Show uncommitted changes or diff between commits.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Optional: Specific file to diff'
            },
            commit: {
              type: 'string',
              description: 'Optional: Compare with specific commit (default: HEAD)'
            }
          },
          required: []
        }
      }
    },

    // 8. TypeScript compile check
    {
      type: 'function',
      function: {
        name: 'type_check',
        description: 'Run TypeScript type checking on a file or the whole project.',
        parameters: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'Optional: Specific file to check'
            }
          },
          required: []
        }
      }
    },

    // 9. Apply patch (the main action tool)
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'Apply a code change to a file. This is the main action tool - use after research to make changes.',
        parameters: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'File to modify'
            },
            search: {
              type: 'string',
              description: 'Exact text to find and replace (must match exactly)'
            },
            replace: {
              type: 'string',
              description: 'New text to replace with'
            },
            description: {
              type: 'string',
              description: 'Brief description of the change'
            }
          },
          required: ['file', 'search', 'replace', 'description']
        }
      }
    },

    // 10. Web search (GitHub, StackOverflow, docs)
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for code examples, best practices, GitHub repos, or documentation. Use this to research before making changes.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (e.g., "typescript singleton pattern best practice" or "lodash debounce github")'
            },
            site: {
              type: 'string',
              description: 'Optional: Limit to specific site (e.g., "github.com", "stackoverflow.com", "npmjs.com")'
            }
          },
          required: ['query']
        }
      }
    },

    // 11. Write file (for creating test files, backups, etc.)
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a file. Use this to create test files, backups, or new modules.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to workspace (e.g., "src/utils/__tests__/helper.test.ts")'
            },
            content: {
              type: 'string',
              description: 'Content to write to the file'
            },
            description: {
              type: 'string',
              description: 'Brief description of why creating this file'
            }
          },
          required: ['path', 'content', 'description']
        }
      }
    },

    // 12. Compare files
    {
      type: 'function',
      function: {
        name: 'compare_files',
        description: 'Compare two files to see differences. Useful for understanding changes or comparing implementations.',
        parameters: {
          type: 'object',
          properties: {
            file1: {
              type: 'string',
              description: 'First file path'
            },
            file2: {
              type: 'string',
              description: 'Second file path'
            }
          },
          required: ['file1', 'file2']
        }
      }
    },

    // 13. Complete task
    {
      type: 'function',
      function: {
        name: 'complete',
        description: 'Signal that you have finished analyzing and making changes. Call this with a detailed summary of what you did.',
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Detailed summary: what you researched, what you changed, why, and any follow-up suggestions'
            },
            changes_made: {
              type: 'number',
              description: 'Number of changes applied'
            },
            files_modified: {
              type: 'string',
              description: 'Comma-separated list of modified files'
            },
            tests_passed: {
              type: 'string',
              description: 'Whether tests passed ("true", "false", or "not_run")'
            }
          },
          required: ['summary', 'changes_made']
        }
      }
    }
  ];
}

/**
 * Execute a tool call and return the result
 */
export async function executeTool(
  toolCall: ToolCall,
  context: ToolContext
): Promise<string> {
  const { name, arguments: argsStr } = toolCall.function;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsStr);
  } catch (error) {
    return JSON.stringify({ error: 'Invalid JSON arguments' });
  }

  try {
    switch (name) {
      case 'read_file':
        return await executeReadFile(args, context);

      case 'search_code':
        return await executeSearchCode(args, context);

      case 'list_files':
        return await executeListFiles(args, context);

      case 'fetch_docs':
        return await executeFetchDocs(args, context);

      case 'run_tests':
        return await executeRunTests(args, context);

      case 'git_history':
        return await executeGitHistory(args, context);

      case 'git_diff':
        return await executeGitDiff(args, context);

      case 'type_check':
        return await executeTypeCheck(args, context);

      case 'apply_patch':
        return await executeApplyPatch(args, context);

      case 'web_search':
        return await executeWebSearch(args, context);

      case 'write_file':
        return await executeWriteFile(args, context);

      case 'compare_files':
        return await executeCompareFiles(args, context);

      case 'complete':
        return JSON.stringify({
          status: 'completed',
          summary: getStringArg(args, 'summary'),
          changes_made: getNumberArg(args, 'changes_made') ?? 0,
          files_modified: getStringArg(args, 'files_modified') ?? '',
          tests_passed: getStringArg(args, 'tests_passed') ?? 'not_run'
        });

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Tool execution failed'
    });
  }
}

// Tool implementations

function getStringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumberArg(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}

async function executeReadFile(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const relativePath = getStringArg(args, 'path');
  if (!relativePath) {
    return JSON.stringify({ error: 'Missing required parameter: path' });
  }
  const filePath = path.join(context.workDir, relativePath);

  // Security check - prevent path traversal
  if (!filePath.startsWith(context.workDir)) {
    return JSON.stringify({ error: 'Path traversal not allowed' });
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    const startLine = getNumberArg(args, 'start_line') ?? 1;
    const endLine = getNumberArg(args, 'end_line') ?? lines.length;

    const selectedLines = lines.slice(startLine - 1, endLine);

    // Check size
    const result = selectedLines.join('\n');
    if (result.length > context.maxFileSize) {
      return JSON.stringify({
        content: result.substring(0, context.maxFileSize),
        truncated: true,
        total_lines: lines.length
      });
    }

    return JSON.stringify({
      content: result,
      lines: selectedLines.length,
      total_lines: lines.length
    });
  } catch (error) {
    return JSON.stringify({ error: `File not found: ${relativePath}` });
  }
}

async function executeSearchCode(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const pattern = getStringArg(args, 'pattern');
  if (!pattern) {
    return JSON.stringify({ error: 'Missing required parameter: pattern' });
  }
  const fileGlob = getStringArg(args, 'file_glob') ?? '*.ts';
  const maxResults = Math.min(getNumberArg(args, 'max_results') ?? 20, context.maxSearchResults);

  try {
    const { stdout } = await exec(
      `rg -n --json "${pattern.replace(/"/g, '\\"')}" --glob "${fileGlob}" | head -${maxResults * 2}`,
      { cwd: context.workDir, timeout: context.timeout, maxBuffer: 5 * 1024 * 1024 }
    );

    const results: Array<{ file: string; line: number; text: string }> = [];

    for (const line of stdout.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'match') {
          results.push({
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            text: parsed.data.lines.text.trim()
          });
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return JSON.stringify({
      matches: results.slice(0, maxResults),
      total: results.length
    });
  } catch (error) {
    // Fallback to grep if ripgrep not available
    try {
      const { stdout } = await exec(
        `grep -rn "${pattern.replace(/"/g, '\\"')}" --include="${fileGlob}" . | head -${maxResults}`,
        { cwd: context.workDir, timeout: context.timeout }
      );

      const results = stdout.split('\n')
        .filter(l => l)
        .map(l => {
          const match = l.match(/^\.\/(.+?):(\d+):(.*)$/);
          return match ? { file: match[1], line: parseInt(match[2]), text: match[3].trim() } : null;
        })
        .filter(Boolean);

      return JSON.stringify({ matches: results, total: results.length });
    } catch {
      return JSON.stringify({ matches: [], total: 0, error: 'Search failed' });
    }
  }
}

async function executeListFiles(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const directoryArg = getStringArg(args, 'directory');
  const directory = path.join(context.workDir, directoryArg ?? '.');
  const pattern = getStringArg(args, 'pattern') ?? '*';
  const recursive = getStringArg(args, 'recursive') === 'true';

  // Security check
  if (!directory.startsWith(context.workDir)) {
    return JSON.stringify({ error: 'Path traversal not allowed' });
  }

  try {
    const findCmd = recursive
      ? `find "${directory}" -name "${pattern}" -type f | head -100`
      : `ls -la "${directory}" 2>/dev/null | head -50`;

    const { stdout } = await exec(findCmd, {
      cwd: context.workDir,
      timeout: context.timeout
    });

    const files = stdout.split('\n').filter(l => l.trim());

    return JSON.stringify({
      directory: directoryArg ?? '.',
      files: files.slice(0, 50),
      count: files.length
    });
  } catch (error) {
    return JSON.stringify({ error: 'Directory not found' });
  }
}

async function executeFetchDocs(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const urlArg = getStringArg(args, 'url');
  if (!urlArg) {
    return JSON.stringify({ error: 'Missing required parameter: url' });
  }
  let url = urlArg;
  const query = getStringArg(args, 'query');

  // Handle npm: prefix
  if (url.startsWith('npm:')) {
    const packageName = url.replace('npm:', '');
    url = `https://registry.npmjs.org/${packageName}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return JSON.stringify({ error: `HTTP ${response.status}` });
    }

    const contentType = response.headers.get('content-type') || '';
    let content: string;
    let title: string | undefined;

    if (contentType.includes('application/json')) {
      const json = await response.json();
      content = JSON.stringify(json, null, 2);
    } else if (contentType.includes('text/html')) {
      const html = await response.text();
      // Use Readability for proper content extraction (same as main OpenClaw agent)
      const readable = await extractReadableContent({
        html,
        url,
        extractMode: 'markdown',
      });
      if (readable?.text) {
        content = readable.text;
        title = readable.title;
      } else {
        // Fallback to basic HTML-to-markdown conversion
        const rendered = htmlToMarkdown(html);
        content = rendered.text;
        title = rendered.title;
      }
    } else {
      content = await response.text();
    }

    // Truncate if too long
    if (content.length > 15000) {
      content = content.substring(0, 15000) + '\n... (truncated)';
    }

    return JSON.stringify({
      url,
      title: title || null,
      content,
      query: query || null
    });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Fetch failed'
    });
  }
}

async function executeRunTests(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const testFile = getStringArg(args, 'test_file');
  const pattern = getStringArg(args, 'pattern');

  try {
    let cmd = 'npx vitest run --reporter=json';
    if (testFile) {
      cmd += ` "${testFile}"`;
    }
    if (pattern) {
      cmd += ` -t "${pattern}"`;
    }

    const { stdout, stderr } = await exec(cmd, {
      cwd: context.workDir,
      timeout: 120000, // 2 minutes for tests
      maxBuffer: 10 * 1024 * 1024
    });

    const output = stdout + stderr;

    // Parse vitest JSON output
    try {
      const jsonMatch = output.match(/\{[\s\S]*"numPassedTests"[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return JSON.stringify({
          passed: result.numPassedTests || 0,
          failed: result.numFailedTests || 0,
          total: result.numTotalTests || 0,
          success: (result.numFailedTests || 0) === 0
        });
      }
    } catch {
      // Fall back to text parsing
    }

    // Text parsing fallback
    const passMatch = output.match(/(\d+) passed/);
    const failMatch = output.match(/(\d+) failed/);

    return JSON.stringify({
      passed: passMatch ? parseInt(passMatch[1]) : 0,
      failed: failMatch ? parseInt(failMatch[1]) : 0,
      success: !failMatch || parseInt(failMatch[1]) === 0,
      output: output.substring(0, 2000)
    });
  } catch (error) {
    return JSON.stringify({
      passed: 0,
      failed: 1,
      success: false,
      error: error instanceof Error ? error.message : 'Test execution failed'
    });
  }
}

async function executeGitHistory(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const filePath = getStringArg(args, 'path');
  const limit = Math.min(getNumberArg(args, 'limit') ?? 10, 50);

  try {
    let cmd = `git log --oneline -${limit}`;
    if (filePath) {
      cmd += ` -- "${filePath}"`;
    }

    const { stdout } = await exec(cmd, {
      cwd: context.workDir,
      timeout: context.timeout
    });

    const commits = stdout.split('\n')
      .filter(l => l)
      .map(l => {
        const match = l.match(/^([a-f0-9]+)\s+(.*)$/);
        return match ? { hash: match[1], message: match[2] } : null;
      })
      .filter(Boolean);

    return JSON.stringify({ commits, count: commits.length });
  } catch (error) {
    return JSON.stringify({ commits: [], error: 'Git history failed' });
  }
}

async function executeGitDiff(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const filePath = getStringArg(args, 'path');
  const commit = getStringArg(args, 'commit') ?? 'HEAD';

  try {
    let cmd = `git diff ${commit}`;
    if (filePath) {
      cmd += ` -- "${filePath}"`;
    }

    const { stdout } = await exec(cmd, {
      cwd: context.workDir,
      timeout: context.timeout,
      maxBuffer: 5 * 1024 * 1024
    });

    const diff = stdout.length > 10000
      ? stdout.substring(0, 10000) + '\n... (truncated)'
      : stdout;

    return JSON.stringify({
      diff: diff || '(no changes)',
      commit
    });
  } catch (error) {
    return JSON.stringify({ diff: '', error: 'Git diff failed' });
  }
}

async function executeTypeCheck(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const file = getStringArg(args, 'file');

  try {
    let cmd = 'npx tsc --noEmit';
    if (file) {
      cmd += ` "${file}"`;
    }

    const { stdout, stderr } = await exec(cmd + ' 2>&1 || true', {
      cwd: context.workDir,
      timeout: 60000
    });

    const output = stdout + stderr;
    const errors = output.split('\n')
      .filter(l => l.includes('error TS'))
      .slice(0, 20);

    return JSON.stringify({
      success: errors.length === 0,
      errors: errors,
      count: errors.length
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      errors: ['Type check execution failed'],
      count: 1
    });
  }
}

async function executeApplyPatch(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const fileArg = getStringArg(args, 'file');
  const search = getStringArg(args, 'search');
  const replace = getStringArg(args, 'replace');
  const description = getStringArg(args, 'description');

  if (!fileArg || !search || replace === undefined || !description) {
    return JSON.stringify({ error: 'Missing required parameters: file, search, replace, description' });
  }

  const filePath = path.join(context.workDir, fileArg);

  // Security check
  if (!filePath.startsWith(context.workDir)) {
    return JSON.stringify({ error: 'Path traversal not allowed' });
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    if (!content.includes(search)) {
      return JSON.stringify({
        success: false,
        error: 'Search pattern not found in file',
        hint: 'Make sure the search text matches exactly (including whitespace)'
      });
    }

    const newContent = content.replace(search, replace);
    await fs.writeFile(filePath, newContent, 'utf-8');

    // Calculate lines changed
    const oldLines = content.split('\n').length;
    const newLines = newContent.split('\n').length;
    const linesDiff = newLines - oldLines;

    return JSON.stringify({
      success: true,
      file: fileArg,
      description,
      lines_added: linesDiff > 0 ? linesDiff : 0,
      lines_removed: linesDiff < 0 ? -linesDiff : 0
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Patch failed'
    });
  }
}

/**
 * Web search - uses the same web_fetch system as the main OpenClaw agent
 * Fetches URL content with Readability extraction (HTML → markdown)
 */
async function executeWebSearch(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const query = getStringArg(args, 'query');
  if (!query) {
    return JSON.stringify({ error: 'Missing required parameter: query' });
  }
  const site = getStringArg(args, 'site');

  // For web search, we construct URLs based on the query
  // GitHub: search code
  // StackOverflow: search questions
  // npm: search packages
  // General: use Google search results page

  let searchUrl: string;
  const encodedQuery = encodeURIComponent(query);

  if (site === 'github.com') {
    // GitHub code search page
    searchUrl = `https://github.com/search?q=${encodedQuery}&type=code`;
  } else if (site === 'stackoverflow.com') {
    // StackOverflow search page
    searchUrl = `https://stackoverflow.com/search?q=${encodedQuery}`;
  } else if (site === 'npmjs.com') {
    // npm search page
    searchUrl = `https://www.npmjs.com/search?q=${encodedQuery}`;
  } else {
    // General search - use Google
    const sitePrefix = site ? `site:${site}+` : '';
    searchUrl = `https://www.google.com/search?q=${sitePrefix}${encodedQuery}`;
  }

  // Use the same fetch approach as fetch_docs
  return executeFetchDocs({ url: searchUrl, query }, context);
}

/**
 * Write file - create or overwrite files (for test files, backups, etc.)
 */
async function executeWriteFile(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const pathArg = getStringArg(args, 'path');
  const content = getStringArg(args, 'content');
  const description = getStringArg(args, 'description');

  if (!pathArg || content === undefined || !description) {
    return JSON.stringify({ error: 'Missing required parameters: path, content, description' });
  }

  const filePath = path.join(context.workDir, pathArg);

  // Security check - prevent path traversal
  if (!filePath.startsWith(context.workDir)) {
    return JSON.stringify({ error: 'Path traversal not allowed' });
  }

  // Prevent overwriting critical files
  const criticalPatterns = [
    /package\.json$/,
    /package-lock\.json$/,
    /pnpm-lock\.yaml$/,
    /\.env$/,
    /tsconfig\.json$/,
    /\.git\//,
    /node_modules\//
  ];

  if (criticalPatterns.some(pattern => pattern.test(pathArg))) {
    return JSON.stringify({
      error: 'Cannot overwrite critical file',
      file: relativePath,
      hint: 'Use apply_patch for modifications to existing config files'
    });
  }

  try {
    // Ensure parent directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Check if file exists (for reporting)
    let existed = false;
    try {
      await fs.access(filePath);
      existed = true;
    } catch {
      // File doesn't exist, that's fine
    }

    // Write the file
    await fs.writeFile(filePath, content, 'utf-8');

    const lines = content.split('\n').length;

    return JSON.stringify({
      success: true,
      file: pathArg,
      description,
      created: !existed,
      overwritten: existed,
      lines
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Write failed'
    });
  }
}

/**
 * Compare files - show differences between two files
 */
async function executeCompareFiles(
  args: ToolArgs,
  context: ToolContext
): Promise<string> {
  const file1Arg = getStringArg(args, 'file1');
  const file2Arg = getStringArg(args, 'file2');

  if (!file1Arg || !file2Arg) {
    return JSON.stringify({ error: 'Missing required parameters: file1, file2' });
  }

  const file1Path = path.join(context.workDir, file1Arg);
  const file2Path = path.join(context.workDir, file2Arg);

  // Security checks
  if (!file1Path.startsWith(context.workDir) || !file2Path.startsWith(context.workDir)) {
    return JSON.stringify({ error: 'Path traversal not allowed' });
  }

  try {
    // Try git diff first (prettier output)
    try {
      const { stdout } = await exec(
        `git diff --no-index -- "${args.file1}" "${args.file2}" 2>/dev/null || true`,
        { cwd: context.workDir, timeout: context.timeout, maxBuffer: 5 * 1024 * 1024 }
      );

      if (stdout.trim()) {
        const diff = stdout.length > 10000
          ? stdout.substring(0, 10000) + '\n... (truncated)'
          : stdout;

        return JSON.stringify({
          diff,
          method: 'git',
          file1: file1Arg,
          file2: file2Arg
        });
      }
    } catch {
      // Git diff failed, fall through to manual comparison
    }

    // Manual comparison
    const [content1, content2] = await Promise.all([
      fs.readFile(file1Path, 'utf-8'),
      fs.readFile(file2Path, 'utf-8')
    ]);

    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');

    if (content1 === content2) {
      return JSON.stringify({
        identical: true,
        lines: lines1.length,
        file1: file1Arg,
        file2: file2Arg
      });
    }

    // Simple line-by-line diff
    const differences: Array<{ line: number; file1: string; file2: string }> = [];
    const maxLines = Math.max(lines1.length, lines2.length);

    for (let i = 0; i < maxLines && differences.length < 50; i++) {
      const l1 = lines1[i] ?? '';
      const l2 = lines2[i] ?? '';
      if (l1 !== l2) {
        differences.push({
          line: i + 1,
          file1: l1.substring(0, 100),
          file2: l2.substring(0, 100)
        });
      }
    }

    return JSON.stringify({
      identical: false,
      file1: file1Arg,
      file2: file2Arg,
      file1_lines: lines1.length,
      file2_lines: lines2.length,
      differences: differences,
      total_differences: differences.length,
      truncated: differences.length >= 50
    });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Compare failed'
    });
  }
}

/**
 * Create default tool context
 */
export function createToolContext(workDir: string): ToolContext {
  return {
    workDir: path.resolve(workDir),
    maxFileSize: 100 * 1024, // 100KB
    maxSearchResults: 50,
    timeout: 30000
  };
}
