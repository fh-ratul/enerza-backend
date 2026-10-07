import httpStatus from "http-status";
import config from "../config";
import { AppError } from "../utils/AppError";
import { getRedis } from "./redis";

// bKash tokenized checkout. Every call in this file is a network call, so
// none of it may run inside a database transaction.

const ID_TOKEN_KEY = "bkash:idToken";
const REFRESH_TOKEN_KEY = "bkash:refreshToken";

// An id token lives for an hour. It is cached for 50 minutes, so a token read
// from the cache always has at least 10 minutes left.
const ID_TOKEN_TTL_SECONDS = 50 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 27 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 30_000;

export const BKASH_SUCCESS_CODE = "0000";

type TBkashTokenResponse = {
	statusCode?: string;
	statusMessage?: string;
	id_token?: string;
	refresh_token?: string;
};

export type TBkashCreateResponse = {
	statusCode?: string;
	statusMessage?: string;
	paymentID?: string;
	bkashURL?: string;
	amount?: string;
	currency?: string;
	merchantInvoiceNumber?: string;
	transactionStatus?: string;
	// bKash reports some failures in these two instead
	errorCode?: string;
	errorMessage?: string;
};

// The token is kept in Redis so every serverless instance shares it. This
// copy is used when Redis is down, so an outage there does not turn every
// payment into a fresh token grant.
let memoryToken: { value: string; expiresAt: number } | null = null;

const readCached = async (key: string): Promise<string | null> => {
	try {
		return await (await getRedis()).get(key);
	} catch {
		return null;
	}
};

const writeCached = async (key: string, value: string, ttlSeconds: number) => {
	try {
		await (await getRedis()).set(key, value, {
			expiration: { type: "EX", value: ttlSeconds },
		});
	} catch {
		// best-effort
	}
};

const postJson = async <T>(
	path: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
): Promise<T> => {
	let response: Response;

	try {
		response = await fetch(`${config.bkash_base_url}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				...headers,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		throw new AppError(
			httpStatus.BAD_GATEWAY,
			"Could not reach bKash. Please try again",
		);
	}

	// bKash answers some rejected requests (wrong credentials, for one) with
	// an empty body. Callers treat a response without the expected fields as
	// a failure, so that case becomes an empty object.
	try {
		return (await response.json()) as T;
	} catch {
		return {} as T;
	}
};

const requestToken = async (refreshToken?: string): Promise<string | null> => {
	const result = await postJson<TBkashTokenResponse>(
		refreshToken
			? "/tokenized/checkout/token/refresh"
			: "/tokenized/checkout/token/grant",
		{ username: config.bkash_username, password: config.bkash_password },
		{
			app_key: config.bkash_app_key,
			app_secret: config.bkash_app_secret,
			...(refreshToken && { refresh_token: refreshToken }),
		},
	);

	if (!result.id_token) {
		return null;
	}

	memoryToken = {
		value: result.id_token,
		expiresAt: Date.now() + ID_TOKEN_TTL_SECONDS * 1000,
	};
	await writeCached(ID_TOKEN_KEY, result.id_token, ID_TOKEN_TTL_SECONDS);

	if (result.refresh_token) {
		await writeCached(
			REFRESH_TOKEN_KEY,
			result.refresh_token,
			REFRESH_TOKEN_TTL_SECONDS,
		);
	}

	return result.id_token;
};

// Cached token → refresh with the stored refresh token → a fresh grant.
export const getBkashIdToken = async (): Promise<string> => {
	const cached = await readCached(ID_TOKEN_KEY);

	if (cached) {
		return cached;
	}

	if (memoryToken && memoryToken.expiresAt > Date.now()) {
		return memoryToken.value;
	}

	const refreshToken = await readCached(REFRESH_TOKEN_KEY);
	const token =
		(refreshToken ? await requestToken(refreshToken) : null) ??
		(await requestToken());

	if (!token) {
		throw new AppError(
			httpStatus.BAD_GATEWAY,
			"bKash did not grant an access token",
		);
	}

	return token;
};

const bkashRequest = async <T>(
	path: string,
	body: Record<string, unknown>,
): Promise<T> =>
	postJson<T>(
		path,
		{
			Authorization: await getBkashIdToken(),
			"X-App-Key": config.bkash_app_key,
		},
		body,
	);

type TCreateBkashPayment = {
	amount: string; // taka with two decimals, e.g. "1845.90"
	invoiceNumber: string;
	payerReference: string;
};

// Opens a checkout session. The customer pays on `bkashURL`, and bKash then
// redirects their browser to our callback.
export const createBkashPayment = ({
	amount,
	invoiceNumber,
	payerReference,
}: TCreateBkashPayment) =>
	bkashRequest<TBkashCreateResponse>("/tokenized/checkout/create", {
		mode: "0011",
		payerReference,
		callbackURL: `${config.bkash_callback_url}/payments/bkash/callback`,
		amount,
		currency: "BDT",
		intent: "sale",
		merchantInvoiceNumber: invoiceNumber,
	});
