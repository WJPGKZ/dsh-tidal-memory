export type Layer = 'L0' | 'L1' | 'L2' | 'L3';
export interface MemoryProposal {
  text: string;
  layer: Exclude<Layer, 'L0'>;
  category?: 'event' | 'task' | 'preference' | 'agreement' | 'knowledge' | 'identity' | 'self' | 'observation';
  tags?: string[];
}
export interface MemoryRecord extends Omit<MemoryProposal, 'layer'> {
  id: string;
  layer: Layer;
  revision: number;
  status: string;
  kind: string;
  scope: 'space';
  sessionId: string;
  occurredAt: string | null;
  source: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
}
export interface RecallResult {
  text: string;
  estimatedTokens: number;
  budget: number;
  accounting: string;
  picked: Array<{ id: string; layer: Layer; reason: string; score: number; hits: string[] }>;
}
export interface TidalMemoryService {
  readonly version: 1;
  forAgent(agent: object): {
    proposeMemory(input: MemoryProposal): MemoryRecord;
    recall(query: string): RecallResult;
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
