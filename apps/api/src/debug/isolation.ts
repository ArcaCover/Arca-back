import type { SourceName } from '@arca/contracts';
import type { AnswerEvent, AssessmentRecord, AssessmentRepository, AssessmentUpdate, InMemoryAssessmentRepository } from '../assessment/repository.js';
import type { InMemoryRepository } from '../repositories/in-memory.js';
import type { ApifyRunUpdate, RawRecord, ReserveApifyRun, ScanRecord, ScanRepository } from '../repositories/types.js';

/**
 * A scan with an injected fault lives entirely in memory (DN-09 5.5); every other scan keeps using the durable repository.
 * Task 5 isolates the scan id before the first write, and wipes `overlay` on a debug reset.
 */
export class RoutingScanRepository implements ScanRepository {
  private readonly isolated = new Set<string>();
  constructor(private readonly durable: ScanRepository, readonly overlay: InMemoryRepository) {}
  isolate(scanId: string): void { this.isolated.add(scanId); }
  isIsolated(scanId: string): boolean { return this.isolated.has(scanId); }
  private of(scanId: string): ScanRepository { return this.isolated.has(scanId) ? this.overlay : this.durable; }
  create(scan: ScanRecord) { return this.of(scan.scan_id).create(scan); }
  get(scanId: string) { return this.of(scanId).get(scanId); }
  complete(scanId: string, update: Pick<ScanRecord, 'status' | 'result' | 'completed_at' | 'duration_ms'>) {
    return this.of(scanId).complete(scanId, update);
  }
  saveRaw(record: RawRecord) { return this.of(record.scan_id).saveRaw(record); }
  // A clean scan must never be served from, or analysed against, a scan with an injected fault: these read durable storage only.
  cached(domain: string, since: string) { return this.durable.cached(domain, since); }
  latestRaw(domain: string, source: SourceName) { return this.durable.latestRaw(domain, source); }
  async recoverInterrupted(before: string) {
    await this.durable.recoverInterrupted(before);
    await this.overlay.recoverInterrupted(before);
  }
  // The ledger holds real spend, so it stays durable. Injected sources never call Apify and the others run without a scanId.
  reserveApifyRun(request: ReserveApifyRun) { return this.durable.reserveApifyRun(request); }
  getApifyRun(id: string) { return this.durable.getApifyRun(id); }
  pendingApifyAccounting(limit: number) { return this.durable.pendingApifyAccounting(limit); }
  updateApifyRun(id: string, update: ApifyRunUpdate) { return this.durable.updateApifyRun(id, update); }
}

/**
 * Follows the scan routing: the assessment of an isolated scan never reaches durable storage. Its id is remembered as
 * isolated and, like the scan ids, never forgotten: after a reset wipes the overlay it answers "not found" from memory
 * instead of falling through to Supabase.
 */
export class RoutingAssessmentRepository implements AssessmentRepository {
  private readonly isolated = new Set<string>();
  constructor(private readonly durable: AssessmentRepository, readonly overlay: InMemoryAssessmentRepository,
    private readonly scans: RoutingScanRepository) {}
  private of(id: string): AssessmentRepository { return this.isolated.has(id) ? this.overlay : this.durable; }
  async create(record: AssessmentRecord) {
    if (!this.scans.isIsolated(record.scan_id)) return this.durable.create(record);
    // Before the write, so the id is never routed anywhere else.
    this.isolated.add(record.id);
    const created = await this.overlay.create(record);
    // An assessment that already existed for the scan is returned instead of the new one; that id is isolated too.
    this.isolated.add(created.id);
    return created;
  }
  get(id: string) { return this.of(id).get(id); }
  getByScan(scanId: string) {
    return (this.scans.isIsolated(scanId) ? this.overlay : this.durable).getByScan(scanId);
  }
  commit(id: string, revision: number, update: AssessmentUpdate, events?: AnswerEvent[]) {
    return this.of(id).commit(id, revision, update, events);
  }
  async planningBefore(before: string) {
    return [...await this.durable.planningBefore(before), ...await this.overlay.planningBefore(before)];
  }
}
