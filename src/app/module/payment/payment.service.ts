import httpStatus from "http-status";
import {
	AuditAction,
	BillStatus,
	PaymentStatus,
} from "../../../generated/prisma/enums";
import type { PaymentSelect } from "../../../generated/prisma/models";
import {
	BKASH_SUCCESS_CODE,
	createBkashPayment,
	executeBkashPayment,
	queryBkashPayment,
	type TBkashCreateResponse,
	type TBkashPaymentResponse,
} from "../../lib/bkash";
import { prisma } from "../../lib/prisma";
import type { RequestUser } from "../../middleware/checkAuth";
import { AppError } from "../../utils/AppError";
import { createAuditLog } from "../../utils/auditLog";
import { CACHE_KEYS, cacheDel } from "../../utils/cache";
import { takaToPaisa } from "../bill/bill.utils";
import type {
	IBkashCallbackQuery,
	IInitiatePaymentPayload,
} from "./payment.interface";
import {
	generateInvoiceNumber,
	judgeBkashResponse,
	type TBkashVerdict,
} from "./payment.utils";

// Customer starts a bKash checkout for one of their own unpaid bills.
//   1. transaction: expire older attempts, create a PENDING payment
//   2. no transaction: ask bKash for a checkout session
//   3. save the bKash payment id, or mark the attempt FAILED
const initiatePayment = async (
	payload: IInitiatePaymentPayload,
	user: RequestUser,
	ip?: string,
) => {
	const { billId } = payload;
	const actor = { userId: user.userId, role: user.role };

	const customer = await prisma.customer.findUnique({
		where: { userId: user.userId },
		select: { id: true, meterNumber: true },
	});

	if (!customer) {
		throw new AppError(httpStatus.NOT_FOUND, "Customer profile not found");
	}

	const payment = await prisma.$transaction(async (tx) => {
		// Two "pay" clicks on the same bill run one after the other, so only
		// the later attempt is left PENDING.
		await tx.$queryRaw`
			SELECT id FROM "bills" WHERE id = ${billId} FOR UPDATE`;

		// Someone else's bill looks exactly like a bill that does not exist.
		const bill = await tx.bill.findFirst({
			where: { id: billId, customerId: customer.id },
			select: {
				id: true,
				billNumber: true,
				billingMonth: true,
				totalAmount: true,
				status: true,
			},
		});

		if (!bill) {
			throw new AppError(httpStatus.NOT_FOUND, "Bill not found", [
				{ path: "billId", message: "Bill not found" },
			]);
		}

		if (bill.status !== BillStatus.UNPAID) {
			throw new AppError(
				httpStatus.CONFLICT,
				`Bill ${bill.billNumber} is already ${bill.status === BillStatus.PAID ? "paid" : "cancelled"}`,
				[{ path: "billId", message: `Bill is ${bill.status}` }],
			);
		}

		await tx.payment.updateMany({
			where: { billId, status: PaymentStatus.PENDING },
			data: { status: PaymentStatus.EXPIRED },
		});

		const created = await tx.payment.create({
			data: {
				amount: bill.totalAmount,
				invoiceNumber: generateInvoiceNumber(),
				billId,
				customerId: customer.id,
			},
			select: { id: true, invoiceNumber: true, currency: true },
		});

		return {
			...created,
			amount: bill.totalAmount.toFixed(2),
			bill: {
				id: bill.id,
				billNumber: bill.billNumber,
				billingMonth: bill.billingMonth,
			},
		};
	});

	let gateway: TBkashCreateResponse | undefined;
	let gatewayError: AppError | undefined;

	try {
		gateway = await createBkashPayment({
			amount: payment.amount,
			invoiceNumber: payment.invoiceNumber,
			payerReference: customer.meterNumber ?? customer.id,
		});
	} catch (error) {
		gatewayError =
			error instanceof AppError
				? error
				: new AppError(httpStatus.BAD_GATEWAY, "Could not reach bKash");
	}

	const { paymentID, bkashURL } = gateway ?? {};

	if (
		!gateway ||
		gateway.statusCode !== BKASH_SUCCESS_CODE ||
		!paymentID ||
		!bkashURL
	) {
		const reason =
			gateway?.statusMessage ??
			gateway?.errorMessage ??
			gatewayError?.message ??
			"No payment session was returned";

		await prisma.$transaction(async (tx) => {
			const failed = await tx.payment.updateMany({
				where: { id: payment.id, status: PaymentStatus.PENDING },
				data: { status: PaymentStatus.FAILED, gatewayResponse: gateway },
			});

			if (failed.count === 1) {
				await createAuditLog(tx, {
					actor,
					action: AuditAction.PAYMENT_FAILED,
					entityType: "Payment",
					entityId: payment.id,
					before: { status: PaymentStatus.PENDING },
					after: {
						status: PaymentStatus.FAILED,
						stage: "INITIATE",
						reason,
						invoiceNumber: payment.invoiceNumber,
						billId,
					},
					ip,
				});
			}
		});

		throw new AppError(
			httpStatus.BAD_GATEWAY,
			`bKash could not start the payment: ${reason}`,
		);
	}

	await prisma.payment.update({
		where: { id: payment.id },
		data: { bkashPaymentId: paymentID, gatewayResponse: gateway },
	});

	return {
		paymentId: payment.id,
		paymentUrl: bkashURL,
		bkashPaymentId: paymentID,
		invoiceNumber: payment.invoiceNumber,
		amount: payment.amount,
		currency: payment.currency,
		status: PaymentStatus.PENDING,
		bill: payment.bill,
	};
};

const paymentSelect = {
	id: true,
	status: true,
	amount: true,
	currency: true,
	invoiceNumber: true,
	bkashPaymentId: true,
	bkashTrxId: true,
	paidAt: true,
	requiresRefund: true,
	createdAt: true,
	updatedAt: true,
	bill: {
		select: {
			id: true,
			billNumber: true,
			billingMonth: true,
			status: true,
			paidAt: true,
		},
	},
} satisfies PaymentSelect;

const CALLBACK_MESSAGE: Record<PaymentStatus, string> = {
	[PaymentStatus.PAID]: "Payment completed successfully",
	[PaymentStatus.CANCELLED]: "Payment was cancelled. The bill is still unpaid",
	[PaymentStatus.FAILED]: "Payment failed. The bill is still unpaid",
	[PaymentStatus.EXPIRED]:
		"This payment session was replaced by a newer one and can no longer be used",
	[PaymentStatus.PENDING]: "Payment is still pending",
};

// The current state of a payment, as the callback reports it.
const getCallbackResult = async (bkashPaymentId: string) => {
	const payment = await prisma.payment.findUniqueOrThrow({
		where: { bkashPaymentId },
		select: paymentSelect,
	});

	return {
		message: payment.requiresRefund
			? `${CALLBACK_MESSAGE[payment.status]}. The amount charged will be refunded`
			: CALLBACK_MESSAGE[payment.status],
		payment: { ...payment, amount: payment.amount.toFixed(2) },
	};
};

type TCloseUnpaid = {
	paymentId: string;
	status: "FAILED" | "CANCELLED";
	reason: string;
	gatewayResponse?: TBkashPaymentResponse;
	requiresRefund?: boolean;
	ip?: string;
};

// PENDING → FAILED / CANCELLED. Conditional, so a callback that arrives twice
// changes (and audits) the payment only once.
const closeUnpaidPayment = async ({
	paymentId,
	status,
	reason,
	gatewayResponse,
	requiresRefund = false,
	ip,
}: TCloseUnpaid) => {
	await prisma.$transaction(async (tx) => {
		const closed = await tx.payment.updateMany({
			where: { id: paymentId, status: PaymentStatus.PENDING },
			data: { status, requiresRefund, gatewayResponse },
		});

		if (closed.count === 0) {
			return;
		}

		await createAuditLog(tx, {
			actor: null,
			action: AuditAction.PAYMENT_FAILED,
			entityType: "Payment",
			entityId: paymentId,
			before: { status: PaymentStatus.PENDING },
			after: { status, stage: "CALLBACK", reason, requiresRefund },
			ip,
		});
	});
};

// bKash redirects the customer's browser here after checkout. Anyone can
// open this URL with any query, so `status=success` proves nothing: the
// payment only counts once bKash itself confirms it.
const handleBkashCallback = async (query: IBkashCallbackQuery, ip?: string) => {
	const { paymentID, status } = query;

	const payment = await prisma.payment.findUnique({
		where: { bkashPaymentId: paymentID },
		select: {
			id: true,
			status: true,
			amount: true,
			invoiceNumber: true,
			billId: true,
		},
	});

	if (!payment) {
		throw new AppError(httpStatus.NOT_FOUND, "Payment not found", [
			{ path: "paymentID", message: "Payment not found" },
		]);
	}

	// Already settled, closed or replaced: report it and change nothing. This
	// is what makes a refreshed or replayed callback harmless.
	if (payment.status !== PaymentStatus.PENDING) {
		return getCallbackResult(paymentID);
	}

	if (status !== "success") {
		await closeUnpaidPayment({
			paymentId: payment.id,
			status:
				status === "cancel" ? PaymentStatus.CANCELLED : PaymentStatus.FAILED,
			reason: `bKash redirected with status=${status}`,
			ip,
		});

		return getCallbackResult(paymentID);
	}

	const expected = {
		bkashPaymentId: paymentID,
		invoiceNumber: payment.invoiceNumber,
		amountPaisa: takaToPaisa(payment.amount),
	};

	// Network calls, so no transaction is open here.
	let gatewayResponse: TBkashPaymentResponse | undefined;
	let verdict: TBkashVerdict | undefined;

	try {
		gatewayResponse = await executeBkashPayment(paymentID);
		verdict = judgeBkashResponse(gatewayResponse, expected);
	} catch {
		// no clear answer: ask for the status below
	}

	// Execute did not confirm it: a timeout, a rejection, or the payment was
	// executed by an earlier callback. The status query is the tie-breaker.
	// If that cannot be reached either, the payment stays PENDING and this
	// same callback can simply be opened again.
	if (verdict?.outcome !== "COMPLETED") {
		gatewayResponse = await queryBkashPayment(paymentID);
		verdict = judgeBkashResponse(gatewayResponse, expected);
	}

	if (verdict.outcome === "NO_ANSWER") {
		throw new AppError(
			httpStatus.BAD_GATEWAY,
			"bKash could not confirm the payment right now. Please try again",
		);
	}

	if (verdict.outcome === "NOT_COMPLETED") {
		throw new AppError(
			httpStatus.CONFLICT,
			"bKash has not completed this payment yet. Finish the checkout in bKash and try again",
		);
	}

	if (verdict.outcome !== "COMPLETED") {
		await closeUnpaidPayment({
			paymentId: payment.id,
			status: PaymentStatus.FAILED,
			reason: verdict.reason,
			gatewayResponse,
			// the money was taken, but not the billed amount
			requiresRefund: verdict.outcome === "AMOUNT_MISMATCH",
			ip,
		});

		return getCallbackResult(paymentID);
	}

	const { trxId } = verdict;
	const now = new Date();

	const settled = await prisma.$transaction(async (tx) => {
		const paid = await tx.payment.updateMany({
			where: { id: payment.id, status: PaymentStatus.PENDING },
			data: {
				status: PaymentStatus.PAID,
				paidAt: now,
				bkashTrxId: trxId,
				gatewayResponse,
			},
		});

		// Another callback for this payment got here first.
		if (paid.count === 0) {
			return false;
		}

		const billPaid = await tx.bill.updateMany({
			where: { id: payment.billId, status: BillStatus.UNPAID },
			data: { status: BillStatus.PAID, paidAt: now },
		});

		// The bill was already paid by another attempt: this money has to go back.
		const requiresRefund = billPaid.count === 0;

		if (requiresRefund) {
			await tx.payment.update({
				where: { id: payment.id },
				data: { requiresRefund: true },
			});
		}

		// Any other open attempt for the bill is of no use now.
		await tx.payment.updateMany({
			where: { billId: payment.billId, status: PaymentStatus.PENDING },
			data: { status: PaymentStatus.EXPIRED },
		});

		await createAuditLog(tx, {
			actor: null,
			action: AuditAction.PAYMENT_COMPLETED,
			entityType: "Payment",
			entityId: payment.id,
			before: { status: PaymentStatus.PENDING },
			after: {
				status: PaymentStatus.PAID,
				amount: payment.amount.toFixed(2),
				bkashTrxId: trxId,
				invoiceNumber: payment.invoiceNumber,
				billId: payment.billId,
				requiresRefund,
			},
			ip,
		});

		return true;
	});

	if (settled) {
		// Revenue and the unpaid total on the dashboard have changed.
		await cacheDel(CACHE_KEYS.adminStats);
	}

	return getCallbackResult(paymentID);
};

export const PaymentServices = {
	initiatePayment,
	handleBkashCallback,
};
