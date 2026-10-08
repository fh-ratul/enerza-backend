import config from "../config";
import { transporter } from "../lib/nodemailer";
import { formatDhaka, toDhakaDateString, toDhakaTimeString } from "./time";

// The seeded demo accounts (…@enerza.com) and RFC 2606 example domains have
// no mailbox behind them, so nothing is ever sent there.
const NO_MAILBOX_DOMAINS = ["enerza.com", "example.com", "example.org"];

const hasMailbox = (email: string) =>
	!NO_MAILBOX_DOMAINS.includes(email.split("@").pop()?.toLowerCase() ?? "");

export type TEmail = {
	to: string | string[];
	subject: string;
	html: string;
};

// Best-effort: a notification must never fail the action it reports on, so
// this never throws. It is awaited by callers (after their transaction has
// committed) because a serverless function may be frozen once it responds.
export const sendEmail = async ({ to, subject, html }: TEmail) => {
	const recipients = [...new Set([to].flat())].filter(hasMailbox);

	if (recipients.length === 0 || config.node_env === "test") {
		return;
	}

	const from = `"Enerza" <${config.email_sender}>`;

	try {
		await transporter.sendMail(
			recipients.length === 1
				? { from, to: recipients[0], subject, html }
				: // several customers: nobody sees the others' addresses
					{ from, to: from, bcc: recipients, subject, html },
		);
	} catch (error) {
		console.warn(
			`Email "${subject}" was not sent: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
};

// ── Templates ───────────────────────────────────────────────────────────────

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const layout = (title: string, body: string) => `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2933">
	<div style="background:#0b5cab;color:#ffffff;padding:16px 24px;font-size:20px;font-weight:bold">Enerza</div>
	<div style="padding:24px;border:1px solid #d9e2ec;border-top:none">
		<h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(title)}</h2>
		${body}
		<p style="margin:24px 0 0;font-size:12px;color:#7b8794">This is an automated message from Enerza. Please do not reply.</p>
	</div>
</div>`;

const rows = (pairs: [string, string][]) =>
	`<table style="border-collapse:collapse;width:100%;margin:12px 0">${pairs
		.map(
			([label, value]) =>
				`<tr><td style="padding:6px 0;color:#52606d">${escapeHtml(label)}</td><td style="padding:6px 0;text-align:right;font-weight:bold">${escapeHtml(value)}</td></tr>`,
		)
		.join("")}</table>`;

const paragraph = (text: string) =>
	`<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(text)}</p>`;

export const welcomeEmail = (user: {
	name: string;
	email: string;
	meterNumber: string | null;
	areaName?: string;
}): TEmail => ({
	to: user.email,
	subject: "Welcome to Enerza",
	html: layout(
		`Welcome, ${user.name}`,
		paragraph(
			"Your account is ready. You can now see the load-shedding schedule for your area, report a power outage and pay your electricity bill with bKash.",
		) +
			rows([
				["Meter number", user.meterNumber ?? "Not set yet"],
				["Area", user.areaName ?? "Not set yet"],
			]),
	),
});

export const billIssuedEmail = (bill: {
	customerName: string;
	email: string;
	billNumber: string;
	billingMonth: string;
	unitsConsumed: number;
	totalAmount: string;
	dueDate: Date;
}): TEmail => ({
	to: bill.email,
	subject: `Your electricity bill for ${bill.billingMonth}`,
	html: layout(
		`Bill for ${bill.billingMonth}`,
		paragraph(`Dear ${bill.customerName}, your electricity bill is ready.`) +
			rows([
				["Bill number", bill.billNumber],
				["Units consumed", `${bill.unitsConsumed} kWh`],
				["Amount due", `BDT ${bill.totalAmount}`],
				["Pay by", toDhakaDateString(bill.dueDate)],
			]) +
			paragraph("You can pay it with bKash from your Enerza account."),
	),
});

export const paymentReceiptEmail = (payment: {
	customerName: string;
	email: string;
	billNumber: string;
	billingMonth: string;
	amount: string;
	bkashTrxId: string;
	paidAt: Date;
	requiresRefund: boolean;
}): TEmail => ({
	to: payment.email,
	subject: `Payment received for bill ${payment.billNumber}`,
	html: layout(
		"Payment received",
		paragraph(
			`Dear ${payment.customerName}, we have received your bKash payment. Thank you.`,
		) +
			rows([
				["Bill number", payment.billNumber],
				["Billing month", payment.billingMonth],
				["Amount paid", `BDT ${payment.amount}`],
				["bKash transaction", payment.bkashTrxId],
				["Paid at", `${formatDhaka(payment.paidAt)} (Dhaka)`],
			]) +
			(payment.requiresRefund
				? paragraph(
						"This bill had already been paid, so this payment will be refunded to your bKash account.",
					)
				: ""),
	),
});

export const outageResolvedEmail = (outage: {
	emails: string[];
	feederName: string;
	resolutionNote: string | null;
	durationMinutes: number | null;
}): TEmail => ({
	to: outage.emails,
	subject: "Power has been restored in your area",
	html: layout(
		"Power restored",
		paragraph(
			`The outage you reported on ${outage.feederName} has been resolved.`,
		) +
			rows([
				["Outage lasted", `${outage.durationMinutes ?? 0} minutes`],
				["What was done", outage.resolutionNote ?? "Supply restored"],
			]) +
			paragraph(
				"If your power is still out, please report it again from your account.",
			),
	),
});

const SCHEDULE_TITLE = {
	LOAD_SHEDDING: "Scheduled load shedding",
	MAINTENANCE: "Scheduled maintenance",
} as const;

export const schedulePublishedEmail = (schedule: {
	emails: string[];
	type: keyof typeof SCHEDULE_TITLE;
	feederName: string;
	startTime: Date;
	endTime: Date;
	reason: string | null;
}): TEmail => ({
	to: schedule.emails,
	subject: `${SCHEDULE_TITLE[schedule.type]} on ${toDhakaDateString(schedule.startTime)}`,
	html: layout(
		SCHEDULE_TITLE[schedule.type],
		paragraph(
			`Power on ${schedule.feederName} will be off during the window below.`,
		) +
			rows([
				["Date", toDhakaDateString(schedule.startTime)],
				[
					"Time (Dhaka)",
					`${toDhakaTimeString(schedule.startTime)} – ${toDhakaTimeString(schedule.endTime)}`,
				],
				["Reason", schedule.reason ?? "Not given"],
			]),
	),
});
