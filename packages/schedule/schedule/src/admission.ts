/** Process-local admission for Schedule delivery work. */

/**
 * One-way process-local gate that releases every waiting Schedule runtime.
 *
 * @remarks This controller owns no durable state. Launchers provide one closed
 * instance before any Schedule runtime is created, then open it only after their native
 * startup transaction commits.
 */
export class ScheduleDeliveryAdmission {
  private readonly opened = Promise.withResolvers<void>()
  private openState: boolean

  /**
   * @param open Whether delivery work is admitted from process start.
   */
  constructor(open: boolean) {
    this.openState = open
    if (open) this.opened.resolve()
  }

  /** Whether delivery work is currently admitted. */
  get isOpen(): boolean {
    return this.openState
  }

  /** Permanently admit delivery work and release every current waiter. */
  open(): void {
    if (this.openState) return
    this.openState = true
    this.opened.resolve()
  }

  /**
   * Wait until delivery work is admitted.
   * @returns A shared promise that resolves once and never rejects.
   */
  whenOpen(): Promise<void> {
    return this.opened.promise
  }
}
