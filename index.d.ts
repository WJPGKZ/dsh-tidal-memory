export type Layer = 'L0' | 'L1' | 'L2' | 'L3';
export interface MemoryProposal {
  text: string;
  layer: Exclude<Layer, 'L0'>;
  category?: 'event' | 'task' | 'preference' | 'agreement' | 'knowledge' | 'identity' | 'self' | 'observation';
  horizon?: 'unspecified' | 'task' | 'event' | 'long_term';
  taskKey?: string;
  tags?: string[];
  aliases?: string[];
}
export interface MemoryRecord extends Omit<MemoryProposal, 'layer'> {
  id: string;
  layer: Layer;
  revision: number;
  status: string;
  kind: string;
  scope: 'space';
  horizon: 'unspecified' | 'task' | 'event' | 'long_term';
  taskKey: string;
  sessionId: string;
  occurredAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  expiredAt: string | null;
  source: Record<string, unknown>;
  claim: { subject: string; predicate: string; value: string; polarity: 'positive' | 'negative'; scope: 'space' } | null;
  sources: Array<Record<string, unknown>>;
  recallCount: number;
  lastRecalledAt: string | null;
}
export interface RecallResult {
  semanticStatus: { mode: 'off' | 'cpu' | 'enhanced'; state: 'disabled' | 'lexical' | 'ready' | 'partial' | 'degraded';
    code?: string; message?: string; model?: string; fingerprint?: string; candidates?: number };
  mode: 'current' | 'history' | 'as-of';
  asOf: string | null;
  text: string;
  estimatedTokens: number;
  budget: number;
  accounting: string;
  threshold: number;
  bestScore: number;
  residentBytes: number;
  contextQueries: number;
  excluded: Array<{ id: string; reason: string; score?: number }>;
  picked: Array<{ id: string; layer: Layer; reason: string; score: number; specificity: number; hits: string[]; matched: boolean;
    channel: 'resident' | 'query' | 'association'; semanticScore: number | null; fusionScore: number | null }>;
}
export interface RecallOptions {
  mode?: 'current' | 'history' | 'as-of';
  asOf?: string;
  includeArchived?: boolean;
}
export interface TidalMemoryService {
  readonly version: 1;
  forAgent(agent: object): {
    proposeMemory(input: MemoryProposal): MemoryRecord;
    recall(query: string): RecallResult;
    recallAsync(query: string, options?: RecallOptions): Promise<RecallResult>;
  };
  privateWriter(ownerContext: object): {
    append(space: string, content: string, sourceIds?: string[]): { id: string; saved: true };
  };
}
export const name: string;
export const inject: readonly string[];
export const provide: readonly string[];
export const Config: unknown;
export function apply(context: object, config?: object): void;
