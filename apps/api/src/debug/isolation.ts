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

/** Follows the scan routing: the assessment of an isolated scan never reaches durable storage. */
export class RoutingAssessmentRepository implements AssessmentRepository {
  constructor(private readonly durable: AssessmentRepository, readonly overlay: InMemoryAssessmentRepository,
    private readonly scans: RoutingScanRepository) {}
  create(record: AssessmentRecord) {
    return (this.scans.isIsolated(record.scan_id) ? this.overlay : this.durable).create(record);
  }
  async get(id: string) { return await this.overlay.get(id) ?? this.durable.get(id); }
  getByScan(scanId: string) {
    return (this.scans.isIsolated(scanId) ? this.overlay : this.durable).getByScan(scanId);
  }
  async commit(id: string, revision: number, update: AssessmentUpdate, events?: AnswerEvent[]) {
    const target = await this.overlay.get(id) ? this.overlay : this.durable;
    return target.commit(id, revision, update, events);
  }
  async planningBefore(before: string) {
    return [...await this.durable.planningBefore(before), ...await this.overlay.planningBefore(before)];
  }
}
