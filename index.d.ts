export type Layer = 'L0' | 'L1' | 'L2' | 'L3';
export interface MemoryProposal {
  text: string;
  layer: Exclude<Layer, 'L0'>;
  category?: 'event' | 'task' | 'preference' | 'agreement' | 'knowledge' | 'identity' | 'self' | 'observation';
  horizon?: 'unspecified' | 'task' | 'event' | 'long_term';
  taskKey?: string;
  tags?: string[];
  aliases?: string[];
  topics?: string[];
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
  archiveReason: 'manual' | 'expired' | 'inactivity' | 'unknown' | null;
  archivedAt: string | null;
  source: Record<string, unknown>;
  claim: { subject: string; predicate: string; value: string; polarity: 'positive' | 'negative'; scope: 'space' } | null;
  sources: Array<Record<string, unknown>>;
  recallCount: number;
  lastRecalledAt: string | null;
}
export interface RecallResult {
  requestId: string;
  semanticStatus: { mode: 'off' | 'cpu' | 'enhanced'; state: 'disabled' | 'lexical' | 'ready' | 'partial' | 'degraded';
    code?: string; message?: string; model?: string; fingerprint?: string; candidates?: number };
  mode: 'current' | 'history' | 'as-of';
  asOf: string | null;
  includeArchived: boolean;
  topicCards: Array<{ id: string; kind: 'topic' | 'fact' | 'task' | 'alias' | 'scene';
    label: string; count: number; evidenceIds: string[] }>;
  topicStatus: { state: 'ready' | 'unavailable'; code?: string; message?: string };
  graphStatus: { state: 'disabled' | 'ready' | 'unprepared' | 'unavailable'; code?: string; message?: string };
  text: string;
  estimatedTokens: number;
  budget: number;
  accounting: string;
  threshold: number;
  bestScore: number;
  residentBytes: number;
  contextQueries: number;
  diagnostics: { lexicalQueryCandidates: number; lexicalContextCandidates: number;
    semanticCandidates: number; semanticValidated: number; uniqueCandidates: number;
    scopeOrTimeFiltered: number; belowThreshold: number; budgetOrLimitExcluded: number;
    returnedQuery: number; returnedResident: number; returnedAssociation: number; returnedGraph: number };
  excluded: Array<{ id: string; reason: string; score?: number }>;
  picked: Array<{ id: string; layer: Layer; reason: string; score: number; specificity: number; hits: string[]; matched: boolean;
    channel: 'resident' | 'query' | 'association'; semanticScore: number | null; fusionScore: number | null;
    graphRelation?: { kind: 'confirmed'; seedId: string } }>;
}
export interface RecallOptions {
  mode?: 'current' | 'history' | 'as-of';
  asOf?: string;
  includeArchived?: boolean;
}
export interface MemoryEventInput {
  text: string;
  eventType: 'result' | 'check' | 'correction' | 'observation';
  operationId: string;
  taskRef?: string | null;
  sceneRef?: string | null;
  sourceIds?: string[];
}
export interface MemoryFocus {
  taskRef?: string | null;
  sceneRef?: string | null;
}
export interface MemoryScene {
  id: string;
  title: string;
  createdAt: string;
  memberCount: number;
}
export interface MemoryChange {
  id: string;
  layer: Exclude<Layer, 'L0'>;
  revision: number;
  status: string;
  changedAt: string;
}
export interface MemoryChangePage {
  items: MemoryChange[];
  cursor: string;
  hasMore: boolean;
}
export interface PrivateJournalContribution {
  content: string;
  operationId?: string;
}
export interface PrivateJournalOrganization {
  day: string;
  expectedHash: string;
  markdown: string;
}
export interface PrivateJournalWriteResult {
  saved: true;
  id?: string;
  day: string;
  revision: number;
  contentHash?: string;
}
export interface EvidenceOptions extends RecallOptions {
  id?: string;
  topic?: string;
  cursor?: string;
  limit?: number;
}
export interface EvidenceRecord {
  id: string;
  layer: Layer;
  text: string;
  status: string;
  sources: Array<Record<string, unknown>>;
  sourcesTotal?: number;
  sourcesComplete?: boolean;
  occurredAt: string | null;
  kind: string;
  horizon: string;
  taskKey: string;
  topics: string[];
  validFrom: string | null;
  validUntil: string | null;
}
export interface EvidencePage {
  topic: string;
  mode: 'current' | 'history' | 'as-of';
  asOf: string | null;
  total: number;
  items: EvidenceRecord[];
  nextCursor: string | null;
}
export interface TidalMemoryService {
  readonly version: 3;
  forAgent(agent: object): {
    proposeMemory(input: MemoryProposal): MemoryRecord;
    recall(query: string): RecallResult;
    recallAsync(query: string, options?: RecallOptions): Promise<RecallResult>;
    readEvidence(options: EvidenceOptions): EvidenceRecord | EvidencePage;
    recordEvent(input: MemoryEventInput): MemoryRecord;
    createScene(input: { title: string; operationId: string }): MemoryScene;
    joinScene(sceneRef: string): MemoryScene;
    scenes(): MemoryScene[];
    setFocus(input: MemoryFocus): { taskRef: string | null; sceneRef: string | null; updatedAt: string | null;
      task: MemoryRecord | null; scene: Pick<MemoryScene, 'id' | 'title' | 'createdAt'> | null };
    focus(): { taskRef: string | null; sceneRef: string | null; updatedAt: string | null;
      task: MemoryRecord | null; scene: Pick<MemoryScene, 'id' | 'title' | 'createdAt'> | null };
    changes(cursor?: string | null, limit?: number): MemoryChangePage;
    contributePrivate(input: PrivateJournalContribution): PrivateJournalWriteResult;
    organizePrivateDay(input: PrivateJournalOrganization): Omit<PrivateJournalWriteResult, 'id'>;
  };
  privateWriter(ownerContext: object): {
    append(space: string, content: string, sourceIds?: string[]): { id: string; saved: true; day: string; revision: number };
  };
}
export const name: string;
export const inject: readonly string[];
export const provide: readonly string[];
export const Config: unknown;
export function apply(context: object, config?: object): void;
