import type { CheckoutStatus } from "@/lib/domain/machine";
import type { CreateCheckoutInput } from "@/lib/square/terminal";
import type { SquareCheckoutState } from "@/lib/square/terminal";
import type { TerminalGateway } from "@/lib/server/sessions";

type Programmed = CheckoutStatus | Error;

/** In-memory stand-in for the Square Terminal API. Mirrors Square's idempotency-key behaviour. */
export class FakeGateway implements TerminalGateway {
  creates: CreateCheckoutInput[] = [];
  cancels: string[] = [];
  gets: string[] = [];
  /** What `create` does next: throw this, or null for normal. Cleared after one use unless sticky. */
  createError: Error | null = null;
  createErrorSticky = false;
  /** Status `create` reports for a brand new checkout (default PENDING). */
  createStatus: CheckoutStatus = "PENDING";
  /** What `cancel` answers; per checkout id overrides the default. */
  cancelDefault: Programmed = "CANCELED";
  cancelFor = new Map<string, Programmed>();
  getDefault: Programmed = "PENDING";
  getFor = new Map<string, Programmed>();

  private seq = 0;
  private byKey = new Map<string, SquareCheckoutState>();

  reset(): void {
    this.creates = [];
    this.cancels = [];
    this.gets = [];
    this.createError = null;
    this.createErrorSticky = false;
    this.createStatus = "PENDING";
    this.cancelDefault = "CANCELED";
    this.cancelFor.clear();
    this.getDefault = "PENDING";
    this.getFor.clear();
    this.seq = 0;
    this.byKey.clear();
  }

  create = async (input: CreateCheckoutInput): Promise<SquareCheckoutState> => {
    this.creates.push(input);
    if (this.createError) {
      const e = this.createError;
      if (!this.createErrorSticky) this.createError = null;
      throw e;
    }
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return existing;
    const state: SquareCheckoutState = {
      id: `chk_${++this.seq}`,
      status: this.createStatus,
      cancelReason: null,
      amountCents: input.amountCents,
    };
    this.byKey.set(input.idempotencyKey, state);
    return state;
  };

  cancel = async (id: string): Promise<SquareCheckoutState> => {
    this.cancels.push(id);
    return this.answer(id, this.cancelFor.get(id) ?? this.cancelDefault);
  };

  get = async (id: string): Promise<SquareCheckoutState> => {
    this.gets.push(id);
    return this.answer(id, this.getFor.get(id) ?? this.getDefault);
  };

  private answer(id: string, p: Programmed): SquareCheckoutState {
    if (p instanceof Error) throw p;
    const amountCents = [...this.byKey.values()].find((s) => s.id === id)?.amountCents ?? 0;
    return { id, status: p, cancelReason: p === "CANCELED" ? "SELLER_CANCELED" : null, amountCents };
  }
}
