import crypto from "node:crypto";
import {
	BKASH_SUCCESS_CODE,
	type TBkashPaymentResponse,
} from "../../lib/bkash";
import { takaToPaisa } from "../bill/bill.utils";

// ENZ-1759830000000-9F3A1C — sent to bKash as merchantInvoiceNumber
export const generateInvoiceNumber = (now: Date = new Date()): string =>
	`ENZ-${now.getTime()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

type TExpectedPayment = {
	bkashPaymentId: string;
	invoiceNumber: string;
	amountPaisa: number;
};

export type TBkashVerdict =
	// money captured for exactly this payment
	| { outcome: "COMPLETED"; trxId: string }
	// the customer has not approved it in bKash yet
	| { outcome: "NOT_COMPLETED" }
	// money captured, but not for the amount we asked for
	| { outcome: "AMOUNT_MISMATCH"; trxId?: string; reason: string }
	| { outcome: "REJECTED"; reason: string }
	// not a bKash payment answer at all (e.g. a proxy's JSON error)
	| { outcome: "NO_ANSWER" };

// Pure: decides what a bKash execute / query response means for one payment.
// The callback's own `status=success` is never trusted; only this is.
export const judgeBkashResponse = (
	response: TBkashPaymentResponse,
	expected: TExpectedPayment,
): TBkashVerdict => {
	const reason =
		response.statusMessage ??
		response.errorMessage ??
		"bKash did not confirm the payment";

	if (!response.statusCode && !response.errorCode) {
		return { outcome: "NO_ANSWER" };
	}

	if (response.statusCode !== BKASH_SUCCESS_CODE) {
		return { outcome: "REJECTED", reason };
	}

	if (response.transactionStatus === "Initiated") {
		return { outcome: "NOT_COMPLETED" };
	}

	if (response.transactionStatus !== "Completed" || !response.trxID) {
		return {
			outcome: "REJECTED",
			reason: `bKash reports the payment as ${response.transactionStatus ?? "unknown"}`,
		};
	}

	if (
		(response.paymentID && response.paymentID !== expected.bkashPaymentId) ||
		(response.merchantInvoiceNumber &&
			response.merchantInvoiceNumber !== expected.invoiceNumber)
	) {
		return {
			outcome: "REJECTED",
			reason: "bKash answered for a different payment",
		};
	}

	if (
		response.amount === undefined ||
		takaToPaisa(response.amount) !== expected.amountPaisa
	) {
		return {
			outcome: "AMOUNT_MISMATCH",
			trxId: response.trxID,
			reason: `bKash captured ${response.amount ?? "an unknown amount"} instead of the billed amount`,
		};
	}

	return { outcome: "COMPLETED", trxId: response.trxID };
};
