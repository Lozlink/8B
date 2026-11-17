import type { Square } from "square";
import type { CheckoutStatus } from "@/lib/domain/machine";
import { AppError } from "@/lib/server/errors";
import type { CatalogGateway } from "@/lib/server/items";
import type { PosGateway } from "@/lib/server/pos-cash";
import type { CashGateway } from "@/lib/server/square-cash";
import type { CreateOrderInput, SquareOrderDetail, SquareOrderState } from "@/lib/square/orders";
import type {
  CreateCashPaymentInput,
  RefundPaymentInput,
  SquarePaymentDetail,
  SquarePaymentState,
  SquareRefundState,
} from "@/lib/square/payments";
import type { CreateCheckoutInput } from "@/lib/square/terminal";
import type { SquareCheckoutState } from "@/lib/square/terminal";
import type { TerminalGateway } from "@/lib/server/sessions";

type Programmed = CheckoutStatus | Error;

/** What the app sees when Square refuses a request outright (`toUpstreamError` shape for a 4xx). */
export const squareRejection = (status = 400, code = "BAD_REQUEST", message = "Square couldn't do that: the request was refused") =>
  new AppError(502, "square_error", message, { status, codes: [code] });

/** What the app sees when Square doesn't answer (`toUpstreamError` shape for a timeout: no HTTP status). */
export const squareTimeout = () => new AppError(502, "square_error", "Square didn't answer in time. Check the Terminal, then try again.");

/** What the app sees when Square answers with a server error (`toUpstreamError` shape for a 5xx). */
export const squareServerError = () =>
  new AppError(502, "square_error", "Square couldn't do that: internal server error", { status: 500, codes: ["INTERNAL_SERVER_ERROR"] });

const round5 = (cents: number) => Math.round(cents / 5) * 5;

/**
 * In-memory stand-in for the Square Terminal, Orders, Payments and Refunds APIs. Mirrors Square's
 * idempotency-key behaviour, and for cash the rules seen in the sandbox: an amount must be a
 * multiple of 5c, and cash for the 5c-rounded total pays an order whose total isn't.
 */
export class FakeGateway implements TerminalGateway, CashGateway, PosGateway {
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

  /** Every createCashPayment call, in order (retries included). */
  cashPayments: CreateCashPaymentInput[] = [];
  /** What `createCashPayment` does next: throw this, or null for normal. Cleared after one use unless sticky. */
  cashError: Error | null = null;
  cashErrorSticky = false;
  /** Square answered too slowly: the payment is made (and its key remembered) and THEN cashError is thrown. */
  cashFailAfterCreating = false;
  /** Runs while a cash payment is "at Square", after it is made and before the answer comes back. */
  duringCashPayment: (() => Promise<void>) | null = null;
  /** Every refundPayment call, in order (retries included). */
  refunds: RefundPaymentInput[] = [];
  refundError: Error | null = null;
  refundErrorSticky = false;

  /** Payments Square holds, by payment id. */
  payments = new Map<string, SquarePaymentDetail & { refundedCents: number }>();
  /** Orders made by sales rung in Square POS (see `posSale`), by order id. */
  posOrders = new Map<string, SquareOrderDetail>();
  /** Every read made for the POS handoff: "order:<id>", "payment:<id>", "list". */
  posReads: string[] = [];
  /** Throw this from every POS read (stays until cleared). */
  posError: Error | null = null;
  private posSeq = 0;
  /** Orders that have been paid: order id → the total after Square's cash rounding. */
  paidOrders = new Map<string, number>();
  /** Refunds Square holds, by refund id. */
  refundsHeld = new Map<string, { paymentId: string; amountCents: number }>();

  private seq = 0;
  private orderSeq = 0;
  private paySeq = 0;
  private refundSeq = 0;
  private payByKey = new Map<string, { body: string; state: SquarePaymentState }>();
  private refundByKey = new Map<string, { body: string; state: SquareRefundState }>();
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
    this.cashPayments = [];
    this.cashError = null;
    this.cashErrorSticky = false;
    this.cashFailAfterCreating = false;
    this.duringCashPayment = null;
    this.refunds = [];
    this.refundError = null;
    this.refundErrorSticky = false;
    this.payments.clear();
    this.posOrders.clear();
    this.posReads = [];
    this.posError = null;
    this.posSeq = 0;
    this.paidOrders.clear();
    this.refundsHeld.clear();
    this.paySeq = 0;
    this.refundSeq = 0;
    this.payByKey.clear();
    this.refundByKey.clear();
  }

  createCashPayment = async (input: CreateCashPaymentInput): Promise<SquarePaymentState> => {
    this.cashPayments.push(input);
    let late: Error | null = null;
    if (this.cashError) {
      const e = this.cashError;
      if (!this.cashErrorSticky) this.cashError = null;
      if (!this.cashFailAfterCreating) throw e;
      late = e;
    }
    const { idempotencyKey, ...rest } = input;
    const body = JSON.stringify(rest);
    const existing = this.payByKey.get(idempotencyKey);
    if (existing) {
      if (existing.body !== body) throw squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
      if (late) throw late;
      return existing.state;
    }
    // Seen in the sandbox: "total_money amount of 1458 is not divisible by AUD currency base cash unit."
    if (input.amountCents <= 0 || input.amountCents % 5 !== 0) {
      throw squareRejection(400, "BAD_REQUEST", `Square couldn't record the cash payment: total_money amount of ${input.amountCents} is not divisible by AUD currency base cash unit.`);
    }
    if (input.orderId) {
      const order = [...this.orderByKey.values()].find((o) => o.state.id === input.orderId)?.state;
      if (!order) throw squareRejection(404, "NOT_FOUND");
      if (this.paidOrders.has(order.id)) throw squareRejection(400, "BAD_REQUEST", "Square couldn't record the cash payment: the order is already paid.");
      // Cash for the rounded total pays the order; Square adds the rounding adjustment itself.
      if (round5(order.totalCents) !== input.amountCents) throw squareRejection(400, "BAD_REQUEST");
      this.paidOrders.set(order.id, input.amountCents);
    }
    const state: SquarePaymentState = {
      id: `pay_${++this.paySeq}`,
      status: "COMPLETED",
      amountCents: input.amountCents,
      orderId: input.orderId ?? null,
    };
    this.payByKey.set(idempotencyKey, { body, state });
    this.payments.set(state.id, {
      ...state,
      refundedCents: 0,
      note: input.note,
      sourceType: "CASH",
      locationId: input.locationId,
      referenceId: input.referenceId,
      createdAt: new Date().toISOString(),
    });
    if (this.duringCashPayment) {
      const hook = this.duringCashPayment;
      this.duringCashPayment = null;
      await hook();
    }
    if (late) throw late;
    return state;
  };

  /**
   * A sale someone took in the Square POS app: Square holds an order and a payment for it, with no
   * reference id. Returns the ids; the order id is what POS hands back as `transaction_id`.
   */
  posSale(input: {
    amountCents: number;
    note?: string | null;
    locationId?: string;
    status?: string;
    sourceType?: string;
    createdAt?: Date;
  }): { orderId: string; paymentId: string } {
    const n = ++this.posSeq;
    const orderId = `pos_ord_${n}`;
    const paymentId = `pos_pay_${n}`;
    const locationId = input.locationId ?? "LOC_TEST";
    const sourceType = input.sourceType ?? "CASH";
    this.posOrders.set(orderId, { id: orderId, locationId, tenders: [{ type: sourceType, paymentId, amountCents: input.amountCents }] });
    this.payments.set(paymentId, {
      id: paymentId,
      status: input.status ?? "COMPLETED",
      sourceType,
      amountCents: input.amountCents,
      locationId,
      orderId,
      note: input.note ?? null,
      referenceId: null,
      createdAt: (input.createdAt ?? new Date()).toISOString(),
      refundedCents: 0,
    });
    return { orderId, paymentId };
  }

  private detail(id: string): SquarePaymentDetail | null {
    const p = this.payments.get(id);
    if (!p) return null;
    const { refundedCents: _refunded, ...detail } = p;
    void _refunded;
    return detail;
  }

  getOrder = async (orderId: string): Promise<SquareOrderDetail> => {
    this.posReads.push(`order:${orderId}`);
    if (this.posError) throw this.posError;
    const o = this.posOrders.get(orderId);
    if (!o) throw squareRejection(404, "NOT_FOUND");
    return o;
  };

  getPayment = async (paymentId: string): Promise<SquarePaymentDetail> => {
    this.posReads.push(`payment:${paymentId}`);
    if (this.posError) throw this.posError;
    const p = this.detail(paymentId);
    if (!p) throw squareRejection(404, "NOT_FOUND");
    return p;
  };

  listCashPayments = async (input: { locationId: string; beginTime: Date }): Promise<SquarePaymentDetail[]> => {
    this.posReads.push("list");
    if (this.posError) throw this.posError;
    return [...this.payments.keys()]
      .map((id) => this.detail(id) as SquarePaymentDetail)
      .filter((p) => p.sourceType === "CASH" && p.locationId === input.locationId && new Date(p.createdAt ?? 0) >= input.beginTime)
      .reverse();
  };

  refundPayment = async (input: RefundPaymentInput): Promise<SquareRefundState> => {
    this.refunds.push(input);
    if (this.refundError) {
      const e = this.refundError;
      if (!this.refundErrorSticky) this.refundError = null;
      throw e;
    }
    const { idempotencyKey, ...rest } = input;
    const body = JSON.stringify(rest);
    const existing = this.refundByKey.get(idempotencyKey);
    if (existing) {
      if (existing.body !== body) throw squareRejection(400, "IDEMPOTENCY_KEY_REUSED");
      return existing.state;
    }
    const payment = this.payments.get(input.paymentId);
    if (!payment) throw squareRejection(404, "NOT_FOUND");
    if (input.amountCents <= 0 || payment.refundedCents + input.amountCents > payment.amountCents) {
      throw squareRejection(400, "REFUND_AMOUNT_INVALID", "Square couldn't record the refund: the amount is more than what is left to refund.");
    }
    payment.refundedCents += input.amountCents;
    // A cash refund starts PENDING and completes on its own.
    const state: SquareRefundState = { id: `ref_${++this.refundSeq}`, status: "PENDING" };
    this.refundByKey.set(idempotencyKey, { body, state });
    this.refundsHeld.set(state.id, { paymentId: input.paymentId, amountCents: input.amountCents });
    return state;
  };

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
