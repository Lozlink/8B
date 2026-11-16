import type { Square } from "square";
import type { CheckoutStatus } from "@/lib/domain/machine";
import { AppError } from "@/lib/server/errors";
import type { CatalogGateway } from "@/lib/server/items";
import type { CreateOrderInput, SquareOrderState } from "@/lib/square/orders";
import type { CreateCheckoutInput } from "@/lib/square/terminal";
import type { SquareCheckoutState } from "@/lib/square/terminal";
import type { TerminalGateway } from "@/lib/server/sessions";

type Programmed = CheckoutStatus | Error;

/** What the app sees when Square refuses a request outright (`toUpstreamError` shape for a 4xx). */
export const squareRejection = (status = 400, code = "BAD_REQUEST", message = "Square couldn't do that: the request was refused") =>
  new AppError(502, "square_error", message, { status, codes: [code] });

/** What the app sees when Square doesn't answer (`toUpstreamError` shape for a timeout: no HTTP status). */
export const squareTimeout = () => new AppError(502, "square_error", "Square didn't answer in time. Check the Terminal, then try again.");

/** In-memory stand-in for the Square Terminal API. Mirrors Square's idempotency-key behaviour. */
export class FakeGateway implements TerminalGateway {
  creates: CreateCheckoutInput[] = [];
  cancels: string[] = [];
  gets: string[] = [];
  /** What `create` does next: throw this, or null for normal. Cleared after one use unless sticky. */
  createError: Error | null = null;
  createErrorSticky = false;
  /**
   * Square answered too slowly: the request is carried out (and its key remembered) and THEN the
   * programmed error is thrown. Applies to createError / orderCheckoutError, and to orderError.
   */
  failAfterCreating = false;
  /** Status `create` reports for a brand new checkout (default PENDING). */
  createStatus: CheckoutStatus = "PENDING";
  /** What `cancel` answers; per checkout id overrides the default. */
  cancelDefault: Programmed = "CANCELED";
  cancelFor = new Map<string, Programmed>();
  getDefault: Programmed = "PENDING";
  getFor = new Map<string, Programmed>();

  /** Every createOrder call, in order. */
  orders: CreateOrderInput[] = [];
  /** What `createOrder` does next: throw this, or null for normal. Cleared after one use unless sticky. */
  orderError: Error | null = null;
  orderErrorSticky = false;
  /** Added to the total Square reports for a new order (to simulate a tax or price rule we don't know about). */
  orderTotalSkewCents = 0;
  /** What `create` does next for a checkout that carries an order id. Cleared after one use unless sticky. */
  orderCheckoutError: Error | null = null;
  orderCheckoutErrorSticky = false;

  private seq = 0;
  private orderSeq = 0;
  private byKey = new Map<string, { body: string; state: SquareCheckoutState }>();
  private orderByKey = new Map<string, { body: string; state: SquareOrderState }>();

  reset(): void {
    this.creates = [];
    this.cancels = [];
    this.gets = [];
    this.createError = null;
    this.createErrorSticky = false;
    this.failAfterCreating = false;
    this.createStatus = "PENDING";
    this.cancelDefault = "CANCELED";
    this.cancelFor.clear();
    this.getDefault = "PENDING";
    this.getFor.clear();
    this.orders = [];
    this.orderError = null;
    this.orderErrorSticky = false;
    this.orderTotalSkewCents = 0;
    this.orderCheckoutError = null;
    this.orderCheckoutErrorSticky = false;
    this.seq = 0;
    this.orderSeq = 0;
    this.byKey.clear();
    this.orderByKey.clear();
  }

  createOrder = async (input: CreateOrderInput): Promise<SquareOrderState> => {
    this.orders.push(input);
    let late: Error | null = null;
    if (this.orderError) {
      const e = this.orderError;
      if (!this.orderErrorSticky) this.orderError = null;
      if (!this.failAfterCreating) throw e;
      late = e;
    }
    const { idempotencyKey, ...rest } = input;
    const body = JSON.stringify(rest);
    const existing = this.orderByKey.get(idempotencyKey);
    if (existing) {
      // Square: the same key with a different body is refused, never silently replayed.
      if (existing.body !== body) throw squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
      return existing.state;
    }
    // GST is inclusive, so Square's total is the sum of the lines.
    const total = input.lines.reduce((sum, l) => sum + l.basePriceCents * l.quantity, 0);
    const state: SquareOrderState = { id: `ord_${++this.orderSeq}`, totalCents: total + this.orderTotalSkewCents };
    this.orderByKey.set(idempotencyKey, { body, state });
    if (late) throw late;
    return state;
  };

  create = async (input: CreateCheckoutInput): Promise<SquareCheckoutState> => {
    this.creates.push(input);
    let late: Error | null = null;
    if (this.createError) {
      const e = this.createError;
      if (!this.createErrorSticky) this.createError = null;
      if (!this.failAfterCreating) throw e;
      late = e;
    } else if (input.orderId && this.orderCheckoutError) {
      const e = this.orderCheckoutError;
      if (!this.orderCheckoutErrorSticky) this.orderCheckoutError = null;
      if (!this.failAfterCreating) throw e;
      late = e;
    }
    const { idempotencyKey, ...rest } = input;
    const body = JSON.stringify(rest);
    const existing = this.byKey.get(idempotencyKey);
    if (existing) {
      if (existing.body !== body) throw squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
      return existing.state;
    }
    if (input.orderId) {
      // Square: a checkout for an order must be for exactly the order's total.
      const order = [...this.orderByKey.values()].find((o) => o.state.id === input.orderId)?.state;
      if (!order) throw squareRejection(404, "NOT_FOUND");
      if (order.totalCents !== input.amountCents) throw squareRejection(400, "BAD_REQUEST");
    }
    const state: SquareCheckoutState = {
      id: `chk_${++this.seq}`,
      status: this.createStatus,
      cancelReason: null,
      amountCents: input.amountCents,
    };
    this.byKey.set(idempotencyKey, { body, state });
    if (late) throw late;
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
    const amountCents = [...this.byKey.values()].find((s) => s.state.id === id)?.state.amountCents ?? 0;
    return { id, status: p, cancelReason: p === "CANCELED" ? "SELLER_CANCELED" : null, amountCents };
  }
}

/** In-memory stand-in for the Square Catalog API: hand it the objects ListCatalog would return. */
export class FakeCatalog implements CatalogGateway {
  objects: Square.CatalogObject[] = [];
  /** Throw this instead of answering (stays until cleared). */
  error: Error | null = null;
  calls = 0;

  reset(): void {
    this.objects = [];
    this.error = null;
    this.calls = 0;
  }

  list = async (): Promise<Square.CatalogObject[]> => {
    this.calls++;
    if (this.error) throw this.error;
    return this.objects;
  };
}
