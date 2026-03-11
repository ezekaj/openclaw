export { EvolutionService } from './evolution-service.js';
export {
  initEvolutionService,
  getEvolutionService,
  isEvolutionServiceRunning,
  resetEvolutionService
} from './instance.js';
export type {
  CodePatch,
  CodeChange,
  TestResult,
  BenchmarkResult,
  ComparisonResult,
  ExperimentResult,
  EvolutionEntry,
  BehaviorAnalysis,
  EvolutionStatus,
  EvolutionConfig
} from './types.js';

// Kimi K2.5 evolution engine (via Bailian API)
export { createEvolutionEngine, startEvolution, type EngineConfig, type CycleResult, type EngineStats, type SupportedModel } from './evolution-engine.js';
export { createKimiClient, getKimiApiKey, getRecommendedKimiModel, type KimiConfig, type EvolutionProposal } from './kimi-client.js';
export { generateEvolutionProposal, testBailianConnection, getAvailableModels, getRecommendedModel } from './bailian-api.js';

// Agentic evolution with tool calling (NEW)
export { createAgenticClient, evolveFile, type AgentConfig, type TaskResult } from './agentic-client.js';
export { getEvolutionTools, executeTool, createToolContext, type ToolDefinition, type ToolCall, type ToolContext } from './evolution-tools.js';
